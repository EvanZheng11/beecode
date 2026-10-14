"use client"

import { useCallback, useRef, useState, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { Clock, GripVertical, Pencil, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { buildSteerPayload, draftRidesBlocks } from "@/lib/prompt-draft"
import type { QueuedMessage } from "@/hooks/use-message-queue"

interface MessageQueueDisplayProps {
  queue: QueuedMessage[]
  onReorder: (items: QueuedMessage[]) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  editingItemId: string | null
  /**
   * 将一个排队项送入当前运行中的回合，使用会话的实时反馈通道。
   * 只有会话存在可用通道且回合正在运行时才传入；宿主负责决定队列项是否移除。
   */
  onSteerItem?: (id: string) => Promise<void> | void
  /** onSteerItem 使用的通道：选择与 composer 分流按钮一致的图标和文案。 */
  steerChannel?: "native" | "pull"
  /** 追加进行中由宿主持有该 id；此时禁用所有队列操作。 */
  appendingQueuedMessageId?: string | null
}

interface QueueItemProps {
  item: QueuedMessage
  index: number
  isEditing: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSteerItem?: (id: string) => Promise<void> | void
  steerChannel: "native" | "pull"
  /** 追加进行中时禁用所有队列控件。 */
  disabled: boolean
  /** 任意一行追加进行中时，所有行的追加按钮都禁用，避免同一通道并发。 */
  steering: boolean
  onSteerStart: (id: string) => Promise<void>
}

function QueueItem({
  item,
  index,
  isEditing,
  onEdit,
  onDelete,
  onSteerItem,
  steerChannel,
  steering,
  disabled,
  onSteerStart,
}: QueueItemProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  const messageListT = useTranslations("Folder.chat.messageList")
  const dragControls = useDragControls()

  // 追加入口必须与实际 payload 编码共用同一门控：
  // * 编辑中的项仍以 composer 草稿为准，不能发送旧内容；
  // * pull 通道不能携带附件 blocks；
  // * 没有可发送文本的 draft 不显示会静默失败的按钮。
  const canSteer =
    Boolean(onSteerItem) &&
    !isEditing &&
    buildSteerPayload(item.draft) !== null &&
    (steerChannel === "native" || !draftRidesBlocks(item.draft))
  const appendLabel = canSteer
    ? messageListT("appendAsFeedback" as Parameters<typeof messageListT>[0])
    : undefined
  const controlsDisabled = disabled || steering

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (controlsDisabled) return
      dragControls.start(event)
    },
    [controlsDisabled, dragControls]
  )

  return (
    <Reorder.Item
      as="div"
      value={item}
      dragListener={false}
      dragControls={dragControls}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        "bg-muted/40 border-border/70",
        isEditing && "border-primary/50 bg-primary/5"
      )}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing p-0 disabled:pointer-events-none disabled:opacity-50"
        disabled={controlsDisabled}
        onPointerDown={startDrag}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
      </button>
      <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
        #{index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-3xs text-foreground/80">
        {item.draft.displayText}
      </span>
      {canSteer && (
        <button
          type="button"
          onClick={() => void onSteerStart(item.id)}
          disabled={disabled || steering}
          className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground disabled:opacity-50"
          title={appendLabel}
          aria-label={appendLabel}
        >
          {steerChannel === "pull" ? (
            <Clock className="h-2.5 w-2.5" />
          ) : (
            <Zap className="h-2.5 w-2.5" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        disabled={controlsDisabled}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground disabled:opacity-50"
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        disabled={controlsDisabled}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground disabled:opacity-50"
        title={t("deleteItem")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  )
}

export function MessageQueueDisplay({
  queue,
  onReorder,
  onEdit,
  onDelete,
  editingItemId,
  onSteerItem,
  steerChannel = "pull",
  appendingQueuedMessageId,
}: MessageQueueDisplayProps) {
  // 当前行和其他行共用一个追加锁，避免多个按钮竞争同一反馈通道；这与 composer
  // 的单飞 steering 防重语义一致。
  const [steeringId, setSteeringId] = useState<string | null>(null)
  // 追加操作的同步重入锁。state 只驱动渲染，ref 在 React 提交禁用态之前就
  // 拒绝同 tick 的第二次点击。
  const steeringIdRef = useRef<string | null>(null)

  const handleSteerStart = useCallback(
    async (id: string) => {
      if (
        !onSteerItem ||
        steeringIdRef.current !== null ||
        appendingQueuedMessageId != null ||
        editingItemId === id
      )
        return
      steeringIdRef.current = id
      setSteeringId(id)
      try {
        await onSteerItem(id)
      } finally {
        steeringIdRef.current = null
        setSteeringId(null)
      }
    },
    [appendingQueuedMessageId, editingItemId, onSteerItem]
  )

  const controlsDisabled =
    steeringId !== null || appendingQueuedMessageId != null

  if (queue.length === 0) return null

  return (
    <div className="max-h-28 overflow-y-auto pb-1">
      <Reorder.Group
        as="div"
        axis="y"
        values={queue}
        onReorder={controlsDisabled ? () => {} : onReorder}
        className="flex flex-col gap-0.5"
      >
        {queue.map((item, index) => (
          <QueueItem
            key={item.id}
            item={item}
            index={index}
            isEditing={editingItemId === item.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onSteerItem={onSteerItem}
            steerChannel={steerChannel}
            steering={steeringId !== null}
            disabled={appendingQueuedMessageId != null}
            onSteerStart={handleSteerStart}
          />
        ))}
      </Reorder.Group>
    </div>
  )
}
