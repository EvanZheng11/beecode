"use client"

import { useTranslations } from "next-intl"

import { PageHeader } from "@/components/ui/page-header"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChannelListTab } from "./channel-list-tab"
import { ChannelCommandsTab } from "./channel-commands-tab"
import { ChannelEventsTab } from "./channel-events-tab"
import { ChannelOtherTab } from "./channel-other-tab"

export function ChatChannelSettings() {
  const t = useTranslations("ChatChannelSettings")

  return (
    <ScrollArea className="h-full">
      <Tabs
        defaultValue="channels"
        className="mx-auto w-full max-w-[80rem] space-y-5 p-4 md:p-6"
      >
        <section>
          <PageHeader
            title={t("sectionTitle")}
            description={t("sectionDescription")}
            className="mb-4"
          />
          <TabsList>
            <TabsTrigger value="channels">{t("tabs.channels")}</TabsTrigger>
            <TabsTrigger value="commands">{t("tabs.commands")}</TabsTrigger>
            <TabsTrigger value="events">{t("tabs.events")}</TabsTrigger>
            <TabsTrigger value="other">{t("tabs.other")}</TabsTrigger>
          </TabsList>
        </section>

        <TabsContent value="channels" className="mt-0">
          <ChannelListTab />
        </TabsContent>
        <TabsContent value="commands" className="mt-0">
          <ChannelCommandsTab />
        </TabsContent>
        <TabsContent value="events" className="mt-0">
          <ChannelEventsTab />
        </TabsContent>
        <TabsContent value="other" className="mt-0">
          <ChannelOtherTab />
        </TabsContent>
      </Tabs>
    </ScrollArea>
  )
}
