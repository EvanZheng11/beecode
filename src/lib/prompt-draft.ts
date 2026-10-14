import type {
  AdaptedContentPart,
  UserImageDisplay,
  UserResourceDisplay,
} from "@/lib/adapters/ai-elements-adapter"
import { foldReferenceLinks } from "@/lib/reference-link"
import type { PromptDraft, PromptInputBlock } from "@/lib/types"

function isResourceLinkBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource_link" }> {
  return block.type === "resource_link"
}

function isEmbeddedResourceBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource" }> {
  return block.type === "resource"
}

function isImageBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "image" }> {
  return block.type === "image"
}

/**
 * An embedded `resource` block that actually carries image bytes — an `image/*`
 * mime + a `blob`. This is how an agent with `image:false` but
 * `embedded_context:true` encodes a pasted image (see
 * `imageAttachmentToPromptBlock`), and how an image in a format the agent
 * cannot decode travels. It must render as a thumbnail like a native image, not
 * as a content-less resource chip.
 */
function isImageResourceBlock(block: PromptInputBlock): block is Extract<
  PromptInputBlock,
  { type: "resource" }
> & {
  blob: string
  mime_type: string
} {
  return (
    block.type === "resource" &&
    typeof block.blob === "string" &&
    block.blob.length > 0 &&
    (block.mime_type?.startsWith("image/") ?? false)
  )
}

function deriveResourceNameFromUri(uri: string): string {
  const fallback = "resource"
  const normalized = uri.trim()
  if (!normalized) return fallback
  const withoutQuery = normalized.split(/[?#]/, 1)[0]
  const candidate = withoutQuery.split(/[\\/]/).pop() ?? ""
  let decoded = ""
  if (candidate) {
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      decoded = candidate
    }
  }
  return decoded || fallback
}

export function getPromptDraftDisplayText(
  draft: PromptDraft,
  attachedResourcesFallback: string
): string {
  const trimmed = draft.displayText.trim()
  return trimmed || attachedResourcesFallback
}

/**
 * The title a new conversation starts with, until its agent names it: the
 * draft's display text the way a title displays (`formatConversationTitle`
 * folds each reference link to its label), cut to `max` characters.
 *
 * Folded BEFORE it is cut. A badge's link can be long — the one for a page the
 * built-in browser handed over carries the page's address — and a cut inside
 * one leaves a link that no longer folds, so the tab and the sidebar showed
 * raw `[Page screenshot](codeg://embedded/…` until the real title arrived.
 */
export function promptDraftTitleSeed(
  draft: PromptDraft,
  attachedResourcesFallback: string,
  max = 80
): string {
  const folded = foldReferenceLinks(
    getPromptDraftDisplayText(draft, attachedResourcesFallback)
  ).trim()
  // Links whose labels are blank fold to nothing; a title still says something.
  return (folded || attachedResourcesFallback).slice(0, max)
}

/**
 * 判断 draft 是否包含纯文本之外的内容（图片附件、文件徽章等），因此必须
 * 以完整 blocks 发送。
 *
 * 这同时是追加入口的资格判断，而不仅是编码细节：只有原生 steering wire
 * 能携带 blocks，所以 pull-tool 会话不能为这类 draft 显示追加入口。它与
 * buildSteerPayload 共用同一事实，避免入口门控和编码规则分叉。
 */
export function draftRidesBlocks(draft: PromptDraft): boolean {
  return draft.blocks.some((b) => b.type !== "text")
}

/**
 * 将 draft 编码为实时反馈（steering）wire。composer 的回合中发送和队列项追加
 * 都使用这里的唯一编码入口，避免两条路径产生不同 payload。
 *
 * 没有可发送文本时返回 null。带非文本 block 时保留完整 blocks；只有原生
 * `_session/steering` wire 能携带 blocks，pull 路径会把这类失败交给回合结束
 * 时的队列 fallback。text 使用记录/显示文本，纯文本 draft 则使用文本 blocks
 * 拼接后的内容。
 */
export function buildSteerPayload(draft: PromptDraft): {
  text: string
  blocks?: PromptInputBlock[]
} | null {
  const blocks = draftRidesBlocks(draft) ? draft.blocks : undefined
  const text = blocks
    ? draft.displayText
    : draft.blocks
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim()
  if (!text.trim()) return null
  return { text, ...(blocks ? { blocks } : {}) }
}

export function buildUserMessageTextPartsFromDraft(
  draft: PromptDraft,
  attachedResourcesFallback: string
): AdaptedContentPart[] {
  return [
    {
      type: "text",
      text: getPromptDraftDisplayText(draft, attachedResourcesFallback),
    },
  ]
}

export function extractUserResourcesFromDraft(
  draft: PromptDraft
): UserResourceDisplay[] {
  const linked = draft.blocks.filter(isResourceLinkBlock).map((resource) => ({
    name: resource.name,
    uri: resource.uri,
    mime_type: resource.mime_type ?? null,
  }))
  const embedded = draft.blocks
    .filter(isEmbeddedResourceBlock)
    // An image-mime embedded resource surfaces as a thumbnail (via
    // `extractUserImagesFromDraft`), not a resource chip.
    .filter((resource) => !isImageResourceBlock(resource))
    .map((resource) => ({
      name: deriveResourceNameFromUri(resource.uri),
      uri: resource.uri,
      mime_type: resource.mime_type ?? null,
    }))
  return [...linked, ...embedded]
}

function deriveImageName(
  uri: string | null | undefined,
  mimeType: string
): string {
  if (uri && uri.trim().length > 0) {
    const name = deriveResourceNameFromUri(uri)
    if (name !== "resource") return name
  }
  const ext = mimeType.split("/")[1]?.split("+")[0] ?? "image"
  return `image.${ext}`
}

export function extractUserImagesFromDraft(
  draft: PromptDraft
): UserImageDisplay[] {
  const native = draft.blocks.filter(isImageBlock).map((image) => ({
    name: deriveImageName(image.uri, image.mime_type),
    data: image.data,
    mime_type: image.mime_type,
    uri: image.uri ?? null,
  }))
  // Grok-style images ride as embedded `resource` blocks (image mime + blob);
  // surface them as thumbnails too, reading the bytes from `blob`.
  const embedded = draft.blocks
    .filter(isImageResourceBlock)
    .map((resource) => ({
      name: deriveImageName(resource.uri, resource.mime_type),
      data: resource.blob,
      mime_type: resource.mime_type,
      uri: resource.uri,
    }))
  return [...native, ...embedded]
}
