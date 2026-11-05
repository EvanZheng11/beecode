"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  codegAuthHeaders,
  probeProxyAuthentication,
  unauthorizedSource,
} from "@/lib/transport/web-auth"

export default function LoginPage() {
  const router = useRouter()
  const t = useTranslations("LoginPage")
  const tConnection = useTranslations("WebConnection")
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.title = t("documentTitle")
  }, [t])

  // Signed in through a proxy in front of Codeg (CODEG_AUTH=proxy-jwt), there
  // is no token to ask for.
  useEffect(() => {
    if (isDesktop()) return
    let cancelled = false
    void probeProxyAuthentication().then((result) => {
      if (!cancelled && result === "proxy") router.replace("/workspace")
    })
    return () => {
      cancelled = true
    }
  }, [router])

  // Desktop users skip login entirely
  if (isDesktop()) {
    router.replace("/workspace")
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      // Validate token by calling a lightweight API endpoint
      const res = await fetch("/api/health", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...codegAuthHeaders(token),
        },
        body: "{}",
      })

      if (res.ok) {
        localStorage.setItem("codeg_token", token)
        router.replace("/workspace")
      } else if (
        res.status === 401 &&
        unauthorizedSource(res.headers.get("www-authenticate")) === "proxy"
      ) {
        // The proxy in front of Codeg refused before the token was checked.
        setError(tConnection("proxySignInDescription"))
      } else if (res.status === 401) {
        setError(t("invalidToken"))
      } else {
        setError(t("connectionFailed", { status: res.status }))
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-backdrop flex min-h-screen items-center justify-center px-6 py-10 text-foreground">
      <div className="grid w-full max-w-[72rem] items-center gap-12 lg:grid-cols-2">
        <div className="hidden space-y-5 lg:block" aria-hidden="true">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary-soft text-primary-text shadow-glass">
            <span className="text-2xl font-semibold">B</span>
          </div>
          <p className="text-display font-semibold tracking-tight">
            {t("brand")}
          </p>
          <p className="max-w-md text-heading text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <div className="surface-glass-strong anim-fade-up w-full max-w-[28rem] space-y-6 justify-self-center rounded-3xl p-6 sm:p-8">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold tracking-tight">{t("brand")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t("tokenPlaceholder")}
                autoFocus
                className="h-11"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              size="lg"
              disabled={!token || loading}
              className="w-full"
            >
              {loading ? t("connecting") : t("connect")}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            {t("helpText")}
          </p>
        </div>
      </div>
    </div>
  )
}
