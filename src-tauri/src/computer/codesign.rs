//! macOS code-signature checks: who is on the other end of a socket, and what
//! a suspended child is about to run.
//!
//! Both questions are answered by the kernel's view of a *running* process,
//! never by a path: a path names a file, and the files in question sit in
//! places another process of the same user can rewrite. The socket peer is
//! named by the audit token the kernel attaches to the connection
//! (`LOCAL_PEERTOKEN`), which carries the pid *and* its version, so a pid that
//! has been recycled does not resolve to the new process. The child is named
//! by its pid while it is suspended and unreaped — our own child, which no
//! one else can have been given its pid.
//!
//! Security.framework and `csops` are not governed by TCC, so these checks
//! are as safe to run inside codeg as inside the helper.

use std::ffi::{c_int, c_void};
use std::os::fd::RawFd;
use std::path::PathBuf;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use core_foundation_sys::array::{
    CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
};
use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFTypeRef};
use core_foundation_sys::data::{CFDataGetTypeID, CFDataRef};
use core_foundation_sys::dictionary::{
    CFDictionaryGetCount, CFDictionaryGetKeysAndValues, CFDictionaryGetTypeID,
    CFDictionaryGetValue, CFDictionaryRef,
};
use core_foundation_sys::string::CFStringRef;
use core_foundation_sys::url::CFURLRef;

use super::driver::DENIED_ENTITLEMENTS;

type SecCodeRef = *const c_void;
type SecRequirementRef = *const c_void;
type OSStatus = i32;
type SecCSFlags = u32;

const K_SEC_CS_DEFAULT_FLAGS: SecCSFlags = 0;
const K_SEC_CS_SIGNING_INFORMATION: SecCSFlags = 1 << 1;
const K_SEC_CS_REQUIREMENT_INFORMATION: SecCSFlags = 1 << 2;
/// `kSecCSCheckAllArchitectures`: every architecture of a universal binary,
/// not only the one this machine would run.
const K_SEC_CS_CHECK_ALL_ARCHITECTURES: SecCSFlags = 1 << 0;
/// `kSecCSStrictValidate` (`SecStaticCode.h`): the reading `codesign --verify
/// --strict` asks for, which also refuses code with anything added around it.
const K_SEC_CS_STRICT_VALIDATE: SecCSFlags = 1 << 4;
/// What a file is held to before it is run: the whole of it, all its
/// architectures, and nothing added around the code it signs. Measured:
/// without the first, a change inside another architecture of a universal
/// binary passes; without the second, one outside the signed region does.
const K_SEC_CS_FILE_FLAGS: SecCSFlags = K_SEC_CS_CHECK_ALL_ARCHITECTURES | K_SEC_CS_STRICT_VALIDATE;

/// `kSecCodeSignatureAdhoc` (`CSCommon.h`): a signature with no certificate
/// chain — what the linker gives a development build, and what `codesign
/// -s -` writes.
pub const CS_ADHOC: u32 = 0x0000_0002;

/// `csops` operations and status bits (`<kern/cs_blobs.h>`).
const CS_OPS_STATUS: u32 = 0;
const CS_OPS_CDHASH: u32 = 5;
pub const CS_VALID: u32 = 0x0000_0001;
pub const CS_GET_TASK_ALLOW: u32 = 0x0000_0004;
pub const CS_RUNTIME: u32 = 0x0001_0000;
pub const CS_DEBUGGED: u32 = 0x1000_0000;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecGuestAttributeAudit: CFStringRef;
    static kSecGuestAttributePid: CFStringRef;
    static kSecCodeInfoIdentifier: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    static kSecCodeInfoUnique: CFStringRef;
    static kSecCodeInfoCdHashes: CFStringRef;
    static kSecCodeInfoFlags: CFStringRef;
    static kSecCodeInfoEntitlementsDict: CFStringRef;
    static kSecCodeInfoCertificates: CFStringRef;

    fn SecCodeCopyGuestWithAttributes(
        host: SecCodeRef,
        attributes: CFDictionaryRef,
        flags: SecCSFlags,
        guest: *mut SecCodeRef,
    ) -> OSStatus;
    fn SecCodeCheckValidity(
        code: SecCodeRef,
        flags: SecCSFlags,
        requirement: SecRequirementRef,
    ) -> OSStatus;
    /// The same question about the code of a file, which is not a running
    /// process: the dynamic call above refuses a static code object
    /// (`errSecCSInvalidObjectRef`).
    fn SecStaticCodeCheckValidity(
        code: SecCodeRef,
        flags: SecCSFlags,
        requirement: SecRequirementRef,
    ) -> OSStatus;
    fn SecRequirementCreateWithString(
        text: CFStringRef,
        flags: SecCSFlags,
        requirement: *mut SecRequirementRef,
    ) -> OSStatus;
    fn SecCodeCopySigningInformation(
        code: SecCodeRef,
        flags: SecCSFlags,
        information: *mut CFDictionaryRef,
    ) -> OSStatus;
    fn SecCodeCopySelf(flags: SecCSFlags, code: *mut SecCodeRef) -> OSStatus;
    /// The code of a file, checked as it is on disk — before anything runs it.
    fn SecStaticCodeCreateWithPath(
        path: CFURLRef,
        flags: SecCSFlags,
        static_code: *mut SecCodeRef,
    ) -> OSStatus;
    /// A certificate's DER, for hashing: `certificate leaf = H"…"` names the
    /// SHA-1 of exactly these bytes.
    fn SecCertificateCopyData(certificate: CFTypeRef) -> CFDataRef;
}

extern "C" {
    /// libsystem_kernel; not in the `libc` crate.
    fn csops(pid: libc::pid_t, ops: u32, useraddr: *mut c_void, usersize: libc::size_t) -> c_int;
    /// CommonCrypto, in libSystem: the SHA-1 code-signature requirements are
    /// written with.
    fn CC_SHA1(data: *const c_void, len: u32, md: *mut u8) -> *mut u8;
}

/// A Core Foundation object this module owns, released on drop.
struct Owned(CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: `self.0` came from a Copy/Create call and is released
            // exactly once, here.
            unsafe { CFRelease(self.0) };
        }
    }
}

/// The kernel's name for the process on the other end of a local socket.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AuditToken(pub [u32; 8]);

impl std::fmt::Debug for AuditToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "AuditToken(pid {}, version {})",
            self.pid(),
            self.pid_version()
        )
    }
}

impl AuditToken {
    /// `audit_token_to_pid`: the sixth word.
    pub fn pid(&self) -> u32 {
        self.0[5]
    }

    /// `audit_token_to_pidversion`: the eighth word. Moves every time a pid
    /// is handed out again.
    pub fn pid_version(&self) -> u32 {
        self.0[7]
    }
}

/// The audit token of the process at the other end of the AF_UNIX socket
/// `fd`.
///
/// For a socketpair this is the last process to have used the *other* end.
/// Both ends of a socketpair start out belonging to whoever created it, so a
/// peer is only meaningful once that other end has been handed over and used
/// — see `protocol`'s note on why the helper speaks first.
pub fn peer_audit_token(fd: RawFd) -> std::io::Result<AuditToken> {
    let mut token = [0u32; 8];
    let mut len = std::mem::size_of_val(&token) as libc::socklen_t;
    // SAFETY: `token` is a 32-byte buffer and `len` says so; the kernel writes
    // at most `len` bytes and reports how many.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERTOKEN,
            token.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of_val(&token) {
        return Err(std::io::Error::other("short LOCAL_PEERTOKEN"));
    }
    Ok(AuditToken(token))
}

/// What to check: a running process, or a file on disk.
#[derive(Debug, Clone)]
pub enum Guest {
    /// A socket peer.
    Audit(AuditToken),
    /// Our own suspended, unreaped child.
    ChildPid(u32),
    /// A file, checked statically — as it is on disk, before anything runs
    /// it: its signature, its certificate and its entitlements are read from
    /// the file, and the validity check is against the code written there.
    StaticFile(PathBuf),
}

/// What a signature says about a running process — or a file on disk — once
/// it has checked out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodeInfo {
    pub identifier: Option<String>,
    pub team_id: Option<String>,
    /// The code-directory hash the kernel uses for this image, lowercase hex.
    pub cdhash: Option<String>,
    /// Every code-directory hash the signature carries of the slice the
    /// framework selects, lowercase hex, in the framework's order: one per
    /// digest algorithm in the signature — **not** one per architecture
    /// (`kSecCodeInfoCdHashes` is that selected slice's array of digests).
    /// The release targets here are thin, x64 or arm64, so there is only one
    /// slice to select; a universal build would need each slice's hashes
    /// collected separately, per architecture. A launch constraint pins all of
    /// these.
    pub cdhashes: Vec<String>,
    /// SHA-1 of the signing (leaf) certificate, uppercase hex — the value a
    /// requirement names as `certificate leaf = H"…"`. `None` for ad-hoc
    /// signed code, which carries no certificate at all.
    pub leaf_sha1: Option<String>,
    /// The code directory's flags (`0x10000` is the hardened runtime).
    pub flags: Option<u32>,
    /// Every entitlement the signature carries that is not a boolean `false`.
    pub entitlements: Vec<String>,
}

impl CodeInfo {
    /// Whether the signature is ad-hoc (`kSecCodeSignatureAdhoc`): no
    /// certificate chain, the way a development build here is signed. `false`
    /// when the signing information carried no flags at all — an answer that
    /// was not read is not one that says "ad-hoc".
    pub fn ad_hoc(&self) -> bool {
        self.flags.is_some_and(|flags| flags & CS_ADHOC != 0)
    }

    /// Refuse a signature carrying any entitlement that would let another
    /// process put code inside this one.
    pub fn entitlements_clean(&self) -> Result<(), String> {
        match self
            .entitlements
            .iter()
            .find(|e| DENIED_ENTITLEMENTS.contains(&e.as_str()))
        {
            Some(denied) => Err(format!("its signature carries {denied}")),
            None => Ok(()),
        }
    }
}

fn status_error(what: &str, status: OSStatus) -> String {
    let name = match status {
        -67050 => " (errSecCSReqFailed: does not satisfy the requirement)",
        -67062 => " (errSecCSUnsigned)",
        -67061 => " (errSecCSSignatureFailed)",
        -67030 => " (errSecCSStaticCodeChanged: the file on disk no longer matches)",
        -67065 => " (errSecCSNoSuchCode)",
        -67052 => " (errSecCSReqInvalid)",
        -67068 => " (errSecCSGuestInvalid)",
        -67071 => " (errSecCSInvalidObjectRef)",
        _ => "",
    };
    format!("{what} failed: OSStatus {status}{name}")
}

fn copy_guest(guest: Guest) -> Result<Owned, String> {
    let mut code: SecCodeRef = std::ptr::null();
    match guest {
        // A file: checked as the code written in it, with no process named.
        Guest::StaticFile(path) => {
            let url = CFURL::from_path(&path, false)
                .ok_or_else(|| format!("no file URL for {}", path.display()))?;
            // SAFETY: `url` is live for the call; `code` receives a +1
            // reference on success.
            let status = unsafe {
                SecStaticCodeCreateWithPath(
                    url.as_concrete_TypeRef(),
                    K_SEC_CS_DEFAULT_FLAGS,
                    &mut code,
                )
            };
            if status != 0 {
                return Err(status_error("SecStaticCodeCreateWithPath", status));
            }
        }
        // A running process, named by the kernel.
        Guest::Audit(token) => {
            // SAFETY: the extern statics are valid CFStrings for the life of
            // the process; wrapping under the get rule retains nothing we
            // must release.
            let attributes = unsafe {
                let bytes: Vec<u8> = token.0.iter().flat_map(|w| w.to_ne_bytes()).collect();
                CFDictionary::from_CFType_pairs(&[(
                    CFString::wrap_under_get_rule(kSecGuestAttributeAudit).as_CFType(),
                    CFData::from_buffer(&bytes).as_CFType(),
                )])
            };
            copy_named_guest(attributes, &mut code)?;
        }
        Guest::ChildPid(pid) => {
            let pid = i32::try_from(pid).map_err(|_| "pid out of range".to_string())?;
            // SAFETY: see `Guest::Audit` above.
            let attributes = unsafe {
                CFDictionary::from_CFType_pairs(&[(
                    CFString::wrap_under_get_rule(kSecGuestAttributePid).as_CFType(),
                    CFNumber::from(pid).as_CFType(),
                )])
            };
            copy_named_guest(attributes, &mut code)?;
        }
    }
    Ok(Owned(code))
}

/// The code of the running process `attributes` names.
fn copy_named_guest(
    attributes: CFDictionary<CFType, CFType>,
    code: &mut SecCodeRef,
) -> Result<(), String> {
    // SAFETY: a null host means "the system's guest registry"; the
    // dictionary is live for the call and `code` receives a +1 reference on
    // success.
    let status = unsafe {
        SecCodeCopyGuestWithAttributes(
            std::ptr::null(),
            attributes.as_concrete_TypeRef(),
            K_SEC_CS_DEFAULT_FLAGS,
            code,
        )
    };
    if status != 0 {
        return Err(status_error("SecCodeCopyGuestWithAttributes", status));
    }
    Ok(())
}

/// The requirement `requirement` names, ready to check code against.
fn create_requirement(requirement: &str) -> Result<Owned, String> {
    let text = CFString::new(requirement);
    let mut req: SecRequirementRef = std::ptr::null();
    // SAFETY: `text` is live; `req` receives a +1 reference on success.
    let status = unsafe {
        SecRequirementCreateWithString(text.as_concrete_TypeRef(), K_SEC_CS_DEFAULT_FLAGS, &mut req)
    };
    if status != 0 {
        return Err(status_error("SecRequirementCreateWithString", status));
    }
    Ok(Owned(req))
}

/// Whether the running process `code` satisfies `requirement` — or, for a
/// `None`, whether it is validly signed at all.
///
/// A null requirement is what the framework reads as "no requirement, only
/// validity": the signature holds and the code is the code the kernel mapped.
/// It is the check to make before any of a signature's own metadata is
/// believed, because `SecCodeCopySigningInformation` succeeds on code whose
/// signature does not hold and then reports it partly.
fn check_requirement(code: &Owned, requirement: Option<&str>) -> Result<(), String> {
    let req = match requirement {
        Some(requirement) => create_requirement(requirement)?,
        // Nothing to release: `Owned` releases a null reference.
        None => Owned(std::ptr::null()),
    };
    // SAFETY: `code` is live and `req.0` is either a live requirement or null,
    // which the call accepts as "no requirement".
    let status = unsafe { SecCodeCheckValidity(code.0, K_SEC_CS_DEFAULT_FLAGS, req.0) };
    if status != 0 {
        return Err(status_error("SecCodeCheckValidity", status));
    }
    Ok(())
}

/// Whether the code of a file (`SecStaticCode`) satisfies `requirement`. The
/// static call, not the dynamic one above: a file is not a running process,
/// and the dynamic check refuses its reference.
///
/// The stricter reading, as `codesign --verify --strict` asks it of a file:
/// the signature and the requirement hold, every architecture of it holds,
/// and nothing has been added outside the code it signs.
fn check_static_requirement(code: &Owned, requirement: &str) -> Result<(), String> {
    let req = create_requirement(requirement)?;
    // SAFETY: both references are live for the call.
    let status = unsafe { SecStaticCodeCheckValidity(code.0, K_SEC_CS_FILE_FLAGS, req.0) };
    if status != 0 {
        return Err(status_error("SecStaticCodeCheckValidity", status));
    }
    Ok(())
}

fn signing_info(code: &Owned) -> Result<CodeInfo, String> {
    let mut raw: CFDictionaryRef = std::ptr::null();
    // SAFETY: `code` is live; `raw` receives a +1 dictionary on success.
    let status = unsafe {
        SecCodeCopySigningInformation(
            code.0,
            K_SEC_CS_SIGNING_INFORMATION | K_SEC_CS_REQUIREMENT_INFORMATION,
            &mut raw,
        )
    };
    if status != 0 {
        return Err(status_error("SecCodeCopySigningInformation", status));
    }
    // SAFETY: a +1 CFDictionary from the call above, released by the wrapper.
    let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    // SAFETY: extern CFString keys, valid for the life of the process.
    let key = |k: CFStringRef| unsafe { CFString::wrap_under_get_rule(k) };
    let string = |k: CFStringRef| {
        dict.find(key(k))
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
    };
    let mut info = CodeInfo {
        // SAFETY for the statics in this block: see `key`.
        identifier: string(unsafe { kSecCodeInfoIdentifier }),
        team_id: string(unsafe { kSecCodeInfoTeamIdentifier }),
        cdhash: dict
            .find(key(unsafe { kSecCodeInfoUnique }))
            .and_then(|v| v.downcast::<CFData>())
            .map(|d| hex(d.bytes())),
        // What the running image's code directory is, for the kernel: the
        // value it names it by, and every other digest the signature carries
        // for the selected slice.
        // SAFETY for the statics in this block: see `key`.
        cdhashes: {
            let mut hashes = unsafe { value_of(raw, kSecCodeInfoUnique) }
                .map(cdhashes_in)
                .unwrap_or_default();
            for hash in unsafe { value_of(raw, kSecCodeInfoCdHashes) }
                .map(cdhashes_in)
                .unwrap_or_default()
            {
                if !hashes.contains(&hash) {
                    hashes.push(hash);
                }
            }
            hashes
        },
        // SAFETY: see `key`.
        leaf_sha1: match unsafe { value_of(raw, kSecCodeInfoCertificates) } {
            // 没有证书键：Adhoc 签名，正常。
            None => None,
            // 有证书却读不出来是签名处在错误状态 —— 拒绝，绝不当成「无证书」。
            Some(certificates) => leaf_certificate_sha1(certificates)?,
        },
        flags: dict
            .find(key(unsafe { kSecCodeInfoFlags }))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .and_then(|n| u32::try_from(n).ok()),
        entitlements: Vec::new(),
    };
    if let Some(ents) = dict
        .find(key(unsafe { kSecCodeInfoEntitlementsDict }))
        .and_then(|v| v.downcast::<CFDictionary>())
    {
        // SAFETY: the dictionary is live; keys come back as borrowed CF refs.
        let ents: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(ents.as_concrete_TypeRef()) };
        let (keys, values) = ents.get_keys_and_values();
        for (k, v) in keys.into_iter().zip(values) {
            // SAFETY: entries of a live dictionary, borrowed.
            let name = unsafe { CFString::wrap_under_get_rule(k as CFStringRef) }.to_string();
            let value = unsafe { CFType::wrap_under_get_rule(v) };
            let off = value
                .downcast::<CFBoolean>()
                .is_some_and(|b| !bool::from(b));
            if !off {
                info.entitlements.push(name);
            }
        }
        info.entitlements.sort();
    }
    Ok(info)
}

/// The value for `key` in a signing-information dictionary.
///
/// # Safety
///
/// `dict` must be a live `CFDictionary` and `key` a valid `CFString`.
unsafe fn value_of(dict: CFDictionaryRef, key: CFStringRef) -> Option<CFTypeRef> {
    let value = CFDictionaryGetValue(dict, key.cast());
    (!value.is_null()).then_some(value)
}

/// Every code-directory hash in `value`, which the framework gives as a single
/// `CFData`, or as an array of them (`kSecCodeInfoCdHashes`: the digests of the
/// **selected slice's** code directory, one per digest algorithm in the
/// signature — not one per architecture) and, where it reports them apart, as a
/// dictionary of them. Empty when the value has another shape: a caller must
/// refuse rather than pin nothing.
fn cdhashes_in(value: CFTypeRef) -> Vec<String> {
    // SAFETY: reads of a live CF object; the sub-objects come back borrowed
    // and are only read.
    unsafe {
        if CFGetTypeID(value) == CFDataGetTypeID() {
            let data: CFData = CFData::wrap_under_get_rule(value as CFDataRef);
            return vec![hex(data.bytes())];
        }
        if CFGetTypeID(value) == CFArrayGetTypeID() {
            let array = value as CFArrayRef;
            return (0..CFArrayGetCount(array))
                .flat_map(|i| cdhashes_in(CFArrayGetValueAtIndex(array, i)))
                .collect();
        }
        if CFGetTypeID(value) == CFDictionaryGetTypeID() {
            let dict = value as CFDictionaryRef;
            let count = CFDictionaryGetCount(dict) as usize;
            let mut keys: Vec<CFTypeRef> = vec![std::ptr::null(); count];
            let mut values: Vec<CFTypeRef> = vec![std::ptr::null(); count];
            CFDictionaryGetKeysAndValues(
                dict,
                keys.as_mut_ptr().cast(),
                values.as_mut_ptr().cast(),
            );
            return values.into_iter().flat_map(cdhashes_in).collect();
        }
    }
    Vec::new()
}

/// SHA-1 of the first certificate of `certificates` — the signing leaf — in
/// uppercase hex: the value `certificate leaf = H"…"` names. `Ok(None)` when
/// the signature carries no certificate at all, which is what an ad-hoc
/// signature is; `Err` when it carries one the framework will not hand over,
/// which is an error about the signature, never "no certificate".
fn leaf_certificate_sha1(certificates: CFTypeRef) -> Result<Option<String>, String> {
    // SAFETY: reads of a live CF object; the certificate comes back borrowed
    // from the array.
    let certificate = unsafe {
        if CFGetTypeID(certificates) != CFArrayGetTypeID() {
            return Err("its certificates are not the array they must be".into());
        }
        let array = certificates as CFArrayRef;
        if CFArrayGetCount(array) < 1 {
            return Ok(None);
        }
        CFArrayGetValueAtIndex(array, 0)
    };
    if certificate.is_null() {
        return Err("its first certificate is null".into());
    }
    // SAFETY: a `SecCertificateRef` borrowed from a live array; its DER copy
    // is a +1 `CFData`, released by the wrapper.
    let der = unsafe { SecCertificateCopyData(certificate) };
    if der.is_null() {
        return Err("its certificate's own bytes could not be read".into());
    }
    // SAFETY: a +1 result of the call above.
    let der = unsafe { CFData::wrap_under_create_rule(der) };
    let mut digest = [0u8; 20];
    // SAFETY: CC_SHA1 writes exactly 20 bytes, whatever the input length.
    unsafe {
        CC_SHA1(
            der.bytes().as_ptr().cast(),
            der.bytes().len() as u32,
            digest.as_mut_ptr(),
        )
    };
    Ok(Some(hex_upper(&digest)))
}

/// Check a running process against a designated-requirement string, and read
/// its signature if it passes.
///
/// `SecCodeCheckValidity` on a running process checks the kernel's view of it
/// (still validly signed) and that the code on disk is the code that is
/// running — a file replaced after `exec` fails here rather than passing on
/// the strength of the new file.
pub fn check_guest(guest: Guest, requirement: &str) -> Result<CodeInfo, String> {
    let file = matches!(guest, Guest::StaticFile(_));
    let code = copy_guest(guest)?;
    if file {
        check_static_requirement(&code, requirement)?;
    } else {
        check_requirement(&code, Some(requirement))?;
    }
    signing_info(&code)
}

/// This process's own signature, **checked for validity and then read**: `Err`
/// for a signature that does not hold — unsigned code included — and for
/// metadata in an error state, such as a certificate the framework will not
/// hand over.
///
/// The order is the point. For the helper's interlock a helper that carries a
/// signing identity but no compiled-in trust anchors refuses to start; and an
/// invalid or unsigned helper must not be able to call itself a development
/// build by the absence of fields that were never read properly.
pub fn self_info() -> Result<CodeInfo, String> {
    let mut code: SecCodeRef = std::ptr::null();
    // SAFETY: `code` receives a +1 reference on success.
    let status = unsafe { SecCodeCopySelf(K_SEC_CS_DEFAULT_FLAGS, &mut code) };
    if status != 0 {
        return Err(status_error("SecCodeCopySelf", status));
    }
    let code = Owned(code);
    check_requirement(&code, None)?;
    signing_info(&code)
}

/// The kernel's code-directory hash for the image `pid` is running, lowercase
/// hex. From the kernel, not the file: this is what is actually mapped.
pub fn running_cdhash(pid: u32) -> std::io::Result<String> {
    let pid = libc::pid_t::try_from(pid).map_err(std::io::Error::other)?;
    let mut hash = [0u8; 20];
    // SAFETY: a 20-byte buffer, and CS_OPS_CDHASH writes exactly 20.
    let rc = unsafe { csops(pid, CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(hex(&hash))
}

/// The kernel's code-signing status bits for `pid` (`CS_VALID`,
/// `CS_RUNTIME`, `CS_GET_TASK_ALLOW`, …).
pub fn running_status(pid: u32) -> std::io::Result<u32> {
    let pid = libc::pid_t::try_from(pid).map_err(std::io::Error::other)?;
    let mut flags: u32 = 0;
    // SAFETY: a u32 out-parameter, which is what CS_OPS_STATUS writes.
    let rc = unsafe {
        csops(
            pid,
            CS_OPS_STATUS,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of::<u32>(),
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(flags)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Certificate fingerprints are written in upper case — the value the release
/// build hands the binary in `CODEG_COMPUTER_CERT_SHA1`.
fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test binary is running, so the kernel knows its cdhash and status,
    /// and its own signature can be read (ad-hoc, linker-signed: no Team ID).
    #[test]
    fn the_kernel_describes_this_process() {
        let me = std::process::id();
        let cdhash = running_cdhash(me).expect("a running process has a cdhash");
        assert_eq!(cdhash.len(), 40);
        let status = running_status(me).expect("and a status");
        assert_ne!(status & CS_VALID, 0);

        let info = self_info().expect("its own signature");
        assert_eq!(info.cdhash.as_deref(), Some(cdhash.as_str()));
    }

    /// A requirement this process cannot meet is refused with the framework's
    /// reason, and a malformed one is refused before any check runs.
    #[test]
    fn an_unmet_requirement_is_refused() {
        let me = Guest::ChildPid(std::process::id());
        let err = check_guest(
            me.clone(),
            "anchor apple generic and certificate leaf[subject.OU] = \"XXXXXXXXXX\"",
        )
        .unwrap_err();
        assert!(err.contains("SecCodeCheckValidity"), "{err}");
        assert!(check_guest(me, "this is not a requirement").is_err());
    }

    /// The peer of one end of a socketpair is whoever last used the other end
    /// — at first, the creator.
    #[test]
    fn a_socketpair_peer_is_named_by_the_kernel() {
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        use std::os::fd::AsRawFd;
        let token = peer_audit_token(a.as_raw_fd()).unwrap();
        assert_eq!(token.pid(), std::process::id());
        drop(b);
    }

    /// A file is checked as it is on disk — before anything runs it — and read
    /// like a running process is: the test binary is ad-hoc signed (no
    /// certificate), and the code directory hash of the file is the one the
    /// kernel reports for this very process.
    #[test]
    fn a_file_is_checked_as_it_is_on_disk() {
        let me = self_info().expect("its own signature");
        let identifier = me.identifier.clone().expect("signed code has one");
        let exe = std::env::current_exe().expect("this test's own binary");
        let file = check_guest(
            Guest::StaticFile(exe.clone()),
            &format!("identifier \"{identifier}\""),
        )
        .expect("the file's own signature holds");
        assert_eq!(file.identifier, me.identifier);
        assert_eq!(file.cdhash, me.cdhash);
        assert!(
            file.cdhashes.contains(me.cdhash.as_ref().unwrap()),
            "{:?}",
            file.cdhashes
        );
        assert_eq!(file.leaf_sha1, None, "ad-hoc code carries no certificate");
        // A requirement it does not meet is refused here too.
        assert!(check_guest(Guest::StaticFile(exe), "anchor apple").is_err());
    }

    /// A signing certificate is read as the SHA-1 fingerprint a requirement
    /// names, in upper case. An Apple-signed system binary has one; ad-hoc
    /// signed code has none.
    #[test]
    fn a_signing_certificate_is_read_as_its_fingerprint() {
        let ls = check_guest(Guest::StaticFile("/bin/ls".into()), "anchor apple")
            .expect("/bin/ls is signed by Apple");
        assert_eq!(ls.identifier.as_deref(), Some("com.apple.ls"));
        let leaf = ls.leaf_sha1.expect("a certificate signature has a leaf");
        assert_eq!(leaf.len(), 40, "{leaf}");
        assert!(
            leaf.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()),
            "{leaf}"
        );
        assert!(!ls.cdhashes.is_empty());
    }

    #[test]
    fn a_denied_entitlement_is_named() {
        let info = CodeInfo {
            entitlements: vec![
                "com.apple.security.device.screen-capture".into(),
                "com.apple.security.cs.allow-dyld-environment-variables".into(),
            ],
            ..CodeInfo::default()
        };
        assert!(info
            .entitlements_clean()
            .unwrap_err()
            .contains("allow-dyld"));
        assert!(CodeInfo::default().entitlements_clean().is_ok());
    }
}
