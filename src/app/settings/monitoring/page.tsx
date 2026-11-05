import { ResourceMonitorSettings } from "@/components/settings/resource-monitor-settings"
import { ScrollArea } from "@/components/ui/scroll-area"

export default function SettingsMonitoringPage() {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-[80rem] p-4 md:p-6">
        <ResourceMonitorSettings />
      </div>
    </ScrollArea>
  )
}
