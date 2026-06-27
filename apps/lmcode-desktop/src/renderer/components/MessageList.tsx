import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { MessageItem } from '@/components/MessageItem'

export function MessageList() {
  const messages = useSessionStore((s) => s.messages)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-7">
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}
      </div>
    </div>
  )
}
