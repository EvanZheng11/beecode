import { ResourceMonitorSettings } from "@/components/settings/resource-monitor-settings"
import { ScrollArea } from "@/components/ui/scroll-area"

export default function SettingsMonitoringPage() {
  return (
    <ScrollArea className="h-full">
      <div className="w-full p-3 md:p-4">
        <ResourceMonitorSettings />
      </div>
    </ScrollArea>
  )
}
