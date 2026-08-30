<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

type LayoutAcknowledgement = {
  enabled: boolean
  revision: number
  updatedAt?: string | null
  reason?: string | null
}

type LayoutControl = {
  enabled: boolean
  revision: number
  updatedAt?: string | null
  reason?: string | null
  deviceGeneration: number | null
  deviceActionId: string | null
  deviceActionRevision: number | null
  deviceActionEnabled: boolean | null
  acknowledgement: LayoutAcknowledgement | null
  synchronized: boolean
}

type Connector = {
  id: string
  kind: string
  channelLabel?: string | null
  accountLabel: string
  displayName: string
  mode: string
  state: string
  capabilities: string[]
  lastSeenAt?: string | null
  layoutControl?: LayoutControl
}

type Conversation = {
  id: string
  connectorId: string
  connectorKind: string
  connectorChannelLabel?: string | null
  conversationType?: string | null
  placement?: string | null
  pinned?: boolean
  title: string
  avatarLabel?: string | null
  avatarPath?: string | null
  unreadCount: number
  lastMessagePreview?: string | null
  lastMessageAt?: string | null
  connectorState: string
  capabilities: string[]
}

type ConversationListItem = Pick<Conversation,
  'id' | 'title' | 'avatarLabel' | 'avatarPath' | 'unreadCount' | 'lastMessagePreview' | 'lastMessageAt' | 'placement' | 'pinned'
>

type Attachment = {
  id: string
  fileName: string
  mimeType?: string | null
  sizeBytes?: number | null
  downloadable?: boolean
}

type Message = {
  id: string
  direction: 'inbound' | 'outbound' | string
  senderName: string
  body: string
  contentType: string
  occurredAt: string
  attachments: Attachment[]
}

type Snapshot = {
  connectors: Connector[]
  conversations: Conversation[]
  messages: Message[]
  selectedConversationId: string | null
}

type StagedAttachment = Attachment & { sha256?: string }
type AvatarRetryState = {
  revision: number
  failures: number
  retryAt: number
  phase: 'failed' | 'loading' | 'loaded'
}

type MessageScrollState = {
  nearBottom: boolean
  scrollTop: number
  anchorMessageId: string | null
  anchorOffset: number
}

const emptySnapshot = (): Snapshot => ({ connectors: [], conversations: [], messages: [], selectedConversationId: null })
const snapshot = ref<Snapshot>(emptySnapshot())
const selectedId = ref('')
const activeFilter = ref('all')
const showInstances = ref(false)
const selectedConnectorId = ref('')
const mobileThread = ref(false)
const loading = ref(true)
const detailLoading = ref(false)
const draft = ref('')
const staged = ref<StagedAttachment[]>([])
const toast = ref('')
let loadRevision = 0
let refreshTimer: number | undefined
let toastTimer: number | undefined
let pendingScrollToBottomId: string | null = null
const draftCache = new Map<string, string>()
const stagedCache = new Map<string, StagedAttachment[]>()
const sendRequestCache = new Map<string, { fingerprint: string; id: string }>()
const sendingConversationIds = ref(new Set<string>())
const uploadingConversationIds = ref(new Set<string>())
const updatingLayoutConnectorIds = ref(new Set<string>())
const avatarRetryStates = ref(new Map<string, AvatarRetryState>())
const AVATAR_RETRY_BASE_MS = 5_000
const AVATAR_RETRY_MAX_MS = 60_000

const selectedConversation = computed(() =>
  snapshot.value.conversations.find((item) => item.id === selectedId.value) ?? null,
)
const selectedConversationConnector = computed(() =>
  snapshot.value.connectors.find((item) => item.id === selectedConversation.value?.connectorId) ?? null,
)
const selectedConnector = computed(() =>
  snapshot.value.connectors.find((item) => item.id === selectedConnectorId.value) ?? null,
)

const filters = computed(() => {
  const labels = new Map<string, string>()
  for (const conversation of snapshot.value.conversations) {
    const label = channelLabel(conversation)
    labels.set(label, label)
  }
  return [
    { id: 'all', label: '全部', count: snapshot.value.conversations.length },
    ...[...labels.values()].map((label) => ({
      id: `channel:${label}`,
      label,
      count: snapshot.value.conversations.filter((item) => channelLabel(item) === label).length,
    })),
  ]
})

const filteredConversations = computed(() => {
  if (activeFilter.value === 'all') return snapshot.value.conversations
  const label = activeFilter.value.slice('channel:'.length)
  return snapshot.value.conversations.filter((item) => channelLabel(item) === label)
})

const conversationRows = computed<ConversationListItem[]>(() => filteredConversations.value.map((conversation) => ({
  id: conversation.id,
  title: conversation.title,
  avatarLabel: conversation.avatarLabel,
  avatarPath: conversation.avatarPath,
  unreadCount: conversation.unreadCount,
  lastMessagePreview: conversation.lastMessagePreview,
  lastMessageAt: conversation.lastMessageAt,
  placement: conversation.placement,
  pinned: conversation.pinned,
})))
const hasKnownConversationActivity = computed(() => Boolean(
  selectedConversation.value?.lastMessageAt || selectedConversation.value?.lastMessagePreview?.trim(),
))

const canSendText = computed(() => selectedConversation.value?.capabilities.includes('send_text') ?? false)
const deviceConversation = computed(() => selectedConversationConnector.value?.mode === 'device_relay')
const maxTextLength = computed(() => deviceConversation.value ? 500 : 20_000)
const canSendFiles = computed(() => {
  if (selectedConversationConnector.value?.mode === 'device_relay'
      && selectedConversation.value?.conversationType !== 'group') return false
  const capabilities = selectedConversation.value?.capabilities ?? []
  return capabilities.includes('send_files') || capabilities.includes('send_images') || capabilities.includes('send_video')
})
const fileAccept = computed(() => {
  const capabilities = selectedConversation.value?.capabilities ?? []
  if (capabilities.includes('send_files')) return undefined
  return [
    ...(capabilities.includes('send_images') ? ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic'] : []),
    ...(capabilities.includes('send_video')
      ? ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska']
      : []),
  ].join(',') || undefined
})
const canSend = computed(() => {
  const hasText = Boolean(draft.value.trim())
  const hasFiles = staged.value.length > 0
  return Boolean(selectedConversation.value)
    && !sendingConversationIds.value.has(selectedId.value)
    && !uploadingConversationIds.value.has(selectedId.value)
    && (hasText || hasFiles)
    && (!deviceConversation.value || !(hasText && hasFiles))
    && (!deviceConversation.value || staged.value.length <= 1)
    && (!hasText || (canSendText.value && draft.value.length <= maxTextLength.value))
    && (!hasFiles || (canSendFiles.value
      && staged.value.every((file) => supportsAttachment(
        selectedConversation.value?.capabilities ?? [], file.mimeType, file.fileName,
      ))))
})

function channelLabel(item: Connector | Conversation | null | undefined) {
  if (!item) return '未知'
  if ('channelLabel' in item && item.channelLabel) return item.channelLabel
  if ('connectorChannelLabel' in item && item.connectorChannelLabel) return item.connectorChannelLabel
  const kind = 'kind' in item ? item.kind : item.connectorKind
  return ({ im: '即时消息', email: '邮箱', sms: '短信', voice: '语音', webhook: 'Webhook' } as Record<string, string>)[kind] || kind
}

function capLabel(capability: string) {
  return ({
    receive_text: '收文字', send_text: '发文字', receive_files: '收附件', send_files: '发附件',
    receive_images: '收图片', send_images: '发图片', receive_video: '收视频', send_video: '发视频',
    threads: '会话串', reactions: '回应', layout_control: '布局控制',
  } as Record<string, string>)[capability] || capability
}

function supportsAttachment(capabilities: string[], mimeType?: string | null, fileName = '') {
  if (capabilities.includes('send_files')) return true
  const mime = String(mimeType || '').toLowerCase()
  const extension = fileName.includes('.') ? fileName.split('.').at(-1)?.toLowerCase() || '' : ''
  const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic'].includes(mime)
    || (!mime && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(extension))
  const video = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska'].includes(mime)
    || (!mime && ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'].includes(extension))
  return (image && capabilities.includes('send_images')) || (video && capabilities.includes('send_video'))
}

function initials(value?: string | null) {
  const text = String(value || '?').trim()
  return [...text].slice(0, 2).join('') || '?'
}

function statusLabel(state?: string | null) {
  return state === 'online' ? '在线' : '离线'
}

function formatListTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

function formatStamp(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString([], {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function conversationPreview(conversation: ConversationListItem) {
  const preview = String(conversation.lastMessagePreview || '').trim()
  if (preview) return preview
  return conversation.lastMessageAt ? '最近消息尚未同步' : '暂无消息'
}

function captureMessageScroll(thread: HTMLElement): MessageScrollState {
  const bounds = thread.getBoundingClientRect()
  const anchor = [...thread.querySelectorAll<HTMLElement>('.message-row')]
    .find((row) => row.getBoundingClientRect().bottom > bounds.top + 1)
  return {
    nearBottom: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80,
    scrollTop: thread.scrollTop,
    anchorMessageId: anchor?.dataset.messageId || null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  }
}

function restoreMessageScroll(thread: HTMLElement, state: MessageScrollState | null) {
  if (!state) return
  const anchor = state.anchorMessageId
    ? [...thread.querySelectorAll<HTMLElement>('.message-row')]
      .find((row) => row.dataset.messageId === state.anchorMessageId)
    : null
  if (anchor) {
    const nextOffset = anchor.getBoundingClientRect().top - thread.getBoundingClientRect().top
    thread.scrollTop += nextOffset - state.anchorOffset
    return
  }
  thread.scrollTop = Math.min(state.scrollTop, Math.max(0, thread.scrollHeight - thread.clientHeight))
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0)
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function isImage(file: Attachment) {
  return Boolean(file.downloadable && file.mimeType?.startsWith('image/'))
}

function isVideo(file: Attachment) {
  return Boolean(file.downloadable && file.mimeType?.startsWith('video/'))
}

function filePath(file: Attachment) {
  return `/api/files/${encodeURIComponent(file.id)}`
}

function avatarRevision(path?: string | null) {
  return path ? avatarRetryStates.value.get(path)?.revision ?? 0 : 0
}

function avatarSource(path?: string | null) {
  if (!path) return ''
  const revision = avatarRevision(path)
  if (!revision) return path
  const hashIndex = path.indexOf('#')
  const base = hashIndex >= 0 ? path.slice(0, hashIndex) : path
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : ''
  return `${base}${base.includes('?') ? '&' : '?'}avatar-retry=${revision}${hash}`
}

function avatarKey(path?: string | null) {
  return `${path || ''}:${avatarRevision(path)}`
}

function retryDelay(failures: number) {
  return Math.min(AVATAR_RETRY_MAX_MS, AVATAR_RETRY_BASE_MS * (2 ** Math.min(Math.max(failures - 1, 0), 4)))
}

function imageFailed(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.classList.add('is-broken')
  const path = image.dataset.avatarPath
  if (!path) return
  const revision = Number(image.dataset.avatarRevision || 0)
  const current = avatarRetryStates.value.get(path)
  if ((current?.revision ?? 0) !== revision || current?.phase === 'failed' || current?.phase === 'loaded') return
  const failures = (current?.failures ?? 0) + 1
  const next = new Map(avatarRetryStates.value)
  next.set(path, {
    revision,
    failures,
    retryAt: Date.now() + retryDelay(failures),
    phase: 'failed',
  })
  avatarRetryStates.value = next
}

function imageLoaded(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.classList.remove('is-broken')
  const path = image.dataset.avatarPath
  if (!path) return
  const revision = Number(image.dataset.avatarRevision || 0)
  const current = avatarRetryStates.value.get(path)
  if (!current || current.revision !== revision || current.phase === 'loaded') return
  const next = new Map(avatarRetryStates.value)
  next.set(path, { revision, failures: 0, retryAt: 0, phase: 'loaded' })
  avatarRetryStates.value = next
}

function advanceAvatarRetries(conversations: Conversation[]) {
  const activePaths = new Set(conversations.map((item) => item.avatarPath).filter((path): path is string => Boolean(path)))
  const now = Date.now()
  const next = new Map(avatarRetryStates.value)
  let changed = false
  for (const [path, state] of next) {
    if (!activePaths.has(path)) {
      next.delete(path)
      changed = true
    } else if (state.phase === 'failed' && state.retryAt <= now) {
      next.set(path, {
        ...state,
        revision: Math.max(now, state.revision + 1),
        phase: 'loading',
      })
      changed = true
    }
  }
  if (changed) avatarRetryStates.value = next
}

function storeComposer() {
  if (!selectedId.value) return
  if (draft.value) draftCache.set(selectedId.value, draft.value)
  else draftCache.delete(selectedId.value)
  if (staged.value.length) stagedCache.set(selectedId.value, [...staged.value])
  else stagedCache.delete(selectedId.value)
}

function restoreComposer(conversationId: string) {
  draft.value = draftCache.get(conversationId) || ''
  staged.value = [...(stagedCache.get(conversationId) || [])]
}

function notify(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 3000)
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options })
  const type = response.headers.get('content-type') || ''
  const body = type.includes('json') ? await response.json() : null
  if (response.status === 401) {
    window.location.replace('/login')
    throw new Error('access_required')
  }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
  return body as T
}

async function load(conversationId = selectedId.value, silent = false, forceScrollToBottom = false) {
  const revision = ++loadRevision
  if (!silent) detailLoading.value = Boolean(conversationId)
  const query = new URLSearchParams({ refresh: String(Date.now()) })
  if (conversationId) query.set('conversationId', conversationId)
  try {
    const body = await api<Snapshot & { ok: boolean }>(`/api/inbox?${query}`)
    if (revision !== loadRevision) return
    const priorThread = document.querySelector<HTMLElement>('.message-scroll')
    const priorSelectedId = selectedId.value
    const scrollState = priorThread ? captureMessageScroll(priorThread) : null
    const nextSelectedId = body.selectedConversationId || ''
    const selectionChanged = nextSelectedId !== priorSelectedId
    if (selectionChanged) {
      storeComposer()
      selectedId.value = nextSelectedId
      restoreComposer(nextSelectedId)
    }
    advanceAvatarRetries(body.conversations)
    body.connectors = mergeConnectorLayoutControls(body.connectors)
    snapshot.value = body
    await nextTick()
    const thread = document.querySelector<HTMLElement>('.message-scroll')
    const shouldForceScroll = forceScrollToBottom || pendingScrollToBottomId === nextSelectedId
    if (thread) {
      if (!silent || selectionChanged || shouldForceScroll || scrollState?.nearBottom !== false) {
        thread.scrollTop = thread.scrollHeight
      } else {
        restoreMessageScroll(thread, scrollState)
      }
    }
    if (shouldForceScroll && pendingScrollToBottomId === nextSelectedId) pendingScrollToBottomId = null
  } finally {
    if (revision === loadRevision) {
      loading.value = false
      detailLoading.value = false
    }
  }
}

async function selectConversation(conversation: Conversation, openMobileThread = true) {
  storeComposer()
  if (conversation.id !== selectedId.value) pendingScrollToBottomId = null
  selectedId.value = conversation.id
  restoreComposer(conversation.id)
  mobileThread.value = openMobileThread
  showInstances.value = false
  detailLoading.value = true
  snapshot.value.messages = []
  try {
    await load(conversation.id)
  } catch (error) {
    notify(`详情加载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function selectConversationById(conversationId: string) {
  const conversation = snapshot.value.conversations.find((item) => item.id === conversationId)
  if (conversation) void selectConversation(conversation)
}

function selectFilter(id: string) {
  activeFilter.value = id
  showInstances.value = false
  mobileThread.value = false
  if (!filteredConversations.value.some((conversation) => conversation.id === selectedId.value)) {
    const nextConversation = filteredConversations.value[0]
    if (nextConversation) {
      void selectConversation(nextConversation, false)
    } else {
      storeComposer()
      pendingScrollToBottomId = null
      selectedId.value = ''
      restoreComposer('')
      snapshot.value.messages = []
      detailLoading.value = false
    }
  }
}

function showConnectorInstances(connectorId: string) {
  selectedConnectorId.value = connectorId
  showInstances.value = true
  mobileThread.value = false
}

function connectorLayoutControl(connector: Connector): LayoutControl {
  return connector.layoutControl ?? {
    enabled: false,
    revision: 0,
    updatedAt: null,
    reason: 'not_configured',
    deviceGeneration: null,
    deviceActionId: null,
    deviceActionRevision: null,
    deviceActionEnabled: null,
    acknowledgement: null,
    synchronized: false,
  }
}

function supportsLayoutAutoRecovery(connector: Connector) {
  return connector.mode === 'device_relay' && connector.capabilities.includes('layout_control')
}

function mergeConnectorLayoutControls(connectors: Connector[]) {
  const previousById = new Map(snapshot.value.connectors.map((connector) => [connector.id, connector]))
  return connectors.map((connector) => {
    const incoming = connector.layoutControl
    const previous = previousById.get(connector.id)?.layoutControl
    if (!supportsLayoutAutoRecovery(connector) || !incoming || !previous) return connector
    if (incoming.revision < previous.revision) return { ...connector, layoutControl: previous }
    if (incoming.revision > previous.revision) return connector
    const incomingAcknowledgement = incoming.acknowledgement
    const previousAcknowledgement = previous.acknowledgement
    const incomingAcknowledgementRevision = incomingAcknowledgement?.revision ?? -1
    const previousAcknowledgementRevision = previousAcknowledgement?.revision ?? -1
    const incomingAcknowledgedAt = Date.parse(incomingAcknowledgement?.updatedAt || '') || 0
    const previousAcknowledgedAt = Date.parse(previousAcknowledgement?.updatedAt || '') || 0
    if (previousAcknowledgementRevision > incomingAcknowledgementRevision ||
        (previousAcknowledgementRevision === incomingAcknowledgementRevision &&
          previousAcknowledgedAt > incomingAcknowledgedAt)) {
      const acknowledgement = previousAcknowledgement
      return {
        ...connector,
        layoutControl: {
          ...incoming,
          acknowledgement,
          synchronized: Boolean(acknowledgement && acknowledgement.revision === incoming.revision &&
            acknowledgement.enabled === incoming.enabled),
        },
      }
    }
    return connector
  })
}

function layoutControlStatus(connector: Connector) {
  if (updatingLayoutConnectorIds.value.has(connector.id)) return '正在更新'
  const state = connectorLayoutControl(connector)
  if (state.enabled) return state.synchronized ? '已在设备启用' : '等待设备启用'
  if (!state.acknowledgement && state.revision === 0) return '尚未启用'
  return state.synchronized ? '已在设备关闭' : '等待设备停止'
}

async function setLayoutAutoRecovery(connector: Connector, enabled: boolean) {
  if (updatingLayoutConnectorIds.value.has(connector.id)) return
  const expectedRevision = connectorLayoutControl(connector).revision
  updatingLayoutConnectorIds.value = new Set([...updatingLayoutConnectorIds.value, connector.id])
  try {
    const result = await api<{ layoutControl: LayoutControl }>(
      `/api/connectors/${encodeURIComponent(connector.id)}/layout-control`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, expectedRevision }),
      },
    )
    const current = snapshot.value.connectors.find((item) => item.id === connector.id)
    if (current) current.layoutControl = result.layoutControl
    notify(enabled ? '已请求启用自动恢复布局' : '已请求关闭自动恢复布局')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'layout_revision_conflict') {
      notify('布局控制状态已更新，正在重新载入')
      await load(selectedId.value, true).catch(() => {})
    } else {
      notify(`布局控制失败：${message}`)
    }
  } finally {
    const remaining = new Set(updatingLayoutConnectorIds.value)
    remaining.delete(connector.id)
    updatingLayoutConnectorIds.value = remaining
  }
}

async function uploadFiles(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const targetConversationId = selectedId.value
  const targetCapabilities = [...(selectedConversation.value?.capabilities ?? [])]
  const targetDeviceConversation = selectedConversationConnector.value?.mode === 'device_relay'
  if (!targetConversationId) return
  const selectedFiles = Array.from(input.files || [])
  if (targetDeviceConversation && staged.value.length + selectedFiles.length > 1) {
    notify('设备接入请每次单独发送一个附件')
    input.value = ''
    return
  }
  uploadingConversationIds.value = new Set([...uploadingConversationIds.value, targetConversationId])
  try {
    for (const file of selectedFiles) {
      if (targetDeviceConversation && (file.size > 10 * 1024 * 1024 || file.name.length > 120
          || /[\\/:*?"<>|\u0000-\u001f]/.test(file.name))) {
        notify(`附件不符合设备接入限制：${file.name}`)
        continue
      }
      if (!supportsAttachment(targetCapabilities, file.type, file.name)) {
        notify(`此接入不支持发送 ${file.name}`)
        continue
      }
      const form = new FormData()
      form.append('file', file)
      try {
        const result = await api<{ attachment: StagedAttachment }>('/api/files', { method: 'POST', body: form })
        if (!supportsAttachment(targetCapabilities, result.attachment.mimeType, result.attachment.fileName)) {
          await api(`/api/files/${encodeURIComponent(result.attachment.id)}`, { method: 'DELETE' })
          notify(`无法验证 ${file.name} 的媒体格式`)
          continue
        }
        if (selectedId.value === targetConversationId) {
          staged.value.push(result.attachment)
        } else {
          const values = stagedCache.get(targetConversationId) || []
          stagedCache.set(targetConversationId, [...values, result.attachment])
        }
        notify(`已添加 ${file.name}`)
      } catch (error) {
        notify(`附件失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    const remaining = new Set(uploadingConversationIds.value)
    remaining.delete(targetConversationId)
    uploadingConversationIds.value = remaining
    input.value = ''
  }
}

async function removeStaged(index: number) {
  const [removed] = staged.value.splice(index, 1)
  if (!removed) return
  try {
    await api(`/api/files/${encodeURIComponent(removed.id)}`, { method: 'DELETE' })
  } catch (error) {
    notify(`附件清理失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function send() {
  const conversation = selectedConversation.value
  if (!conversation || !canSend.value || sendingConversationIds.value.has(conversation.id)) return
  const targetConversationId = conversation.id
  const sentDraft = draft.value
  const sentFiles = [...staged.value]
  const fingerprint = JSON.stringify([sentDraft, sentFiles.map((file) => file.id)])
  const cachedRequest = sendRequestCache.get(targetConversationId)
  const clientRequestId = cachedRequest?.fingerprint === fingerprint
    ? cachedRequest.id : `web-${crypto.randomUUID()}`
  sendRequestCache.set(targetConversationId, { fingerprint, id: clientRequestId })
  sendingConversationIds.value = new Set([...sendingConversationIds.value, targetConversationId])
  try {
    await api('/api/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        body: sentDraft,
        attachmentIds: sentFiles.map((file) => file.id),
        clientRequestId,
      }),
    })
  } catch (error) {
    notify(`发送失败：${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    const remaining = new Set(sendingConversationIds.value)
    remaining.delete(targetConversationId)
    sendingConversationIds.value = remaining
  }
  if (sendRequestCache.get(targetConversationId)?.id === clientRequestId) sendRequestCache.delete(targetConversationId)
  if (draftCache.get(targetConversationId) === sentDraft) draftCache.delete(targetConversationId)
  const sentFileIds = new Set(sentFiles.map((file) => file.id))
  const cachedFiles = stagedCache.get(targetConversationId)
  if (cachedFiles) {
    const remaining = cachedFiles.filter((file) => !sentFileIds.has(file.id))
    if (remaining.length) stagedCache.set(targetConversationId, remaining)
    else stagedCache.delete(targetConversationId)
  }
  if (selectedId.value === targetConversationId) {
    if (draft.value === sentDraft) draft.value = ''
    staged.value = staged.value.filter((file) => !sentFileIds.has(file.id))
  }
  notify('已加入发送队列')
  if (selectedId.value === targetConversationId) pendingScrollToBottomId = targetConversationId
  try {
    await load(selectedId.value, true, selectedId.value === targetConversationId)
  } catch {
    notify('已加入发送队列，列表稍后自动刷新')
  }
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

function onPageShow() {
  void load(selectedId.value, true).catch(() => {})
}

function onVisibilityChange() {
  if (!document.hidden) void load(selectedId.value, true).catch(() => {})
}

onMounted(async () => {
  try {
    await load()
  } catch (error) {
    notify(`加载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) void load(selectedId.value, true).catch(() => {})
  }, 5_000)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
  if (toastTimer) window.clearTimeout(toastTimer)
  window.removeEventListener('pageshow', onPageShow)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <main class="mc-shell" :class="{ 'is-thread-open': mobileThread, 'is-instances-open': showInstances }">
    <aside class="nav-pane">
      <div class="brand" aria-label="Message Center">
        <span class="brand-mark">M</span>
        <strong>Message Center</strong>
      </div>

      <div class="nav-scroll">
        <div class="nav-section">
          <p class="nav-label">渠道</p>
          <button
            v-for="filter in filters"
            :key="filter.id"
            class="nav-item"
            :class="{ active: activeFilter === filter.id && !showInstances }"
            type="button"
            @click="selectFilter(filter.id)"
          >
            <span class="nav-glyph">{{ initials(filter.label) }}</span>
            <span class="nav-copy">{{ filter.label }}</span>
            <span class="nav-count">{{ filter.count }}</span>
          </button>
        </div>

        <div class="nav-section connector-nav">
          <p class="nav-label">接入实例</p>
          <button
            v-for="connector in snapshot.connectors"
            :key="connector.id"
            class="nav-item connector-item"
            :class="{ active: showInstances && selectedConnectorId === connector.id }"
            type="button"
            @click="showConnectorInstances(connector.id)"
          >
            <span class="nav-glyph">{{ initials(channelLabel(connector)) }}</span>
            <span class="nav-copy connector-copy">
              <strong>{{ connector.accountLabel }}</strong>
              <small>{{ channelLabel(connector) }} · {{ connector.id }}</small>
            </span>
            <span class="presence-dot" :class="connector.state" :title="statusLabel(connector.state)" />
          </button>
          <p v-if="!snapshot.connectors.length && !loading" class="nav-empty">尚无接入</p>
        </div>
      </div>

      <div class="nav-footer">
        <a class="license-link" href="/vendor/winui/NOTICE.md" target="_blank" rel="noreferrer">许可</a>
        <form method="post" action="/api/auth/logout">
          <button class="quiet-button logout-button" type="submit" aria-label="退出登录" title="退出登录">↪</button>
        </form>
      </div>
    </aside>

    <section v-if="!showInstances" class="conversation-pane">
      <header class="pane-header">
        <div>
          <h1>收件箱</h1>
          <p>{{ filteredConversations.length }} 个会话 · {{ snapshot.connectors.length }} 个接入实例</p>
        </div>
        <button class="quiet-button refresh-button" type="button" aria-label="刷新" title="刷新" @click="load(selectedId)">↻</button>
      </header>

      <div class="conversation-list">
        <button
          v-for="conversation in conversationRows"
          :key="conversation.id"
          class="conversation-row"
          :class="{
            active: selectedId === conversation.id,
            pinned: conversation.pinned,
            folded: conversation.placement === 'folded' || conversation.placement === 'message_box',
          }"
          type="button"
          @click="selectConversationById(conversation.id)"
        >
          <span class="avatar conversation-avatar">
            <span>{{ initials(conversation.avatarLabel || conversation.title) }}</span>
            <img
              v-if="conversation.avatarPath"
              :key="avatarKey(conversation.avatarPath)"
              :src="avatarSource(conversation.avatarPath)"
              :data-avatar-path="conversation.avatarPath"
              :data-avatar-revision="avatarRevision(conversation.avatarPath)"
              alt=""
              loading="lazy"
              @load="imageLoaded"
              @error="imageFailed"
            >
          </span>
          <span class="conversation-copy">
            <span class="conversation-title-row">
              <strong>
                <span v-if="conversation.pinned" class="state-mark" title="置顶" aria-label="置顶">◆</span>
                <span
                  v-if="conversation.placement === 'folded' || conversation.placement === 'message_box'"
                  class="state-mark folded-mark"
                  :title="conversation.placement === 'message_box' ? '消息盒子' : '折叠聊天'"
                  :aria-label="conversation.placement === 'message_box' ? '消息盒子' : '折叠聊天'"
                >▱</span>
                {{ conversation.title }}
              </strong>
              <time>{{ formatListTime(conversation.lastMessageAt) }}</time>
            </span>
            <span class="conversation-preview">{{ conversationPreview(conversation) }}</span>
          </span>
          <span v-if="conversation.unreadCount" class="unread-count">{{ conversation.unreadCount }}</span>
        </button>

        <div v-if="!filteredConversations.length && !loading" class="empty-state">
          <span class="empty-glyph">□</span>
          <p>暂无会话</p>
        </div>
        <div v-if="loading" class="loading-state"><span class="spinner" />正在载入</div>
      </div>
    </section>

    <section v-if="!showInstances" class="content-pane">
      <template v-if="selectedConversation">
        <header class="thread-header">
          <button class="quiet-button mobile-back" type="button" aria-label="返回收件箱" @click="mobileThread = false">←</button>
          <span class="avatar thread-avatar">
            <span>{{ initials(selectedConversation.avatarLabel || selectedConversation.title) }}</span>
            <img
              v-if="selectedConversation.avatarPath"
              :key="avatarKey(selectedConversation.avatarPath)"
              :src="avatarSource(selectedConversation.avatarPath)"
              :data-avatar-path="selectedConversation.avatarPath"
              :data-avatar-revision="avatarRevision(selectedConversation.avatarPath)"
              alt=""
              @load="imageLoaded"
              @error="imageFailed"
            >
          </span>
          <h2>{{ selectedConversation.title }}</h2>
          <span class="status-pill" :class="selectedConversation.connectorState">
            <span class="presence-dot" :class="selectedConversation.connectorState" />
            {{ statusLabel(selectedConversation.connectorState) }}
          </span>
        </header>

        <div class="message-scroll" :class="{ busy: detailLoading }">
          <article
            v-for="message in snapshot.messages"
            :key="message.id"
            :data-message-id="message.id"
            class="message-row"
            :class="message.direction"
          >
            <div class="message-block">
              <p class="message-meta">{{ message.senderName }} · {{ formatStamp(message.occurredAt) }}</p>
              <div class="message-bubble">
                <p v-if="message.body">{{ message.body }}</p>
                <div v-for="file in message.attachments" :key="file.id" class="attachment">
                  <img v-if="isImage(file)" class="attachment-image" :src="filePath(file)" :alt="file.fileName" loading="lazy">
                  <video v-else-if="isVideo(file)" class="attachment-video" :src="filePath(file)" controls preload="metadata" />
                  <a v-else-if="file.downloadable" class="attachment-link" :href="filePath(file)">
                    <span class="file-icon">▤</span>
                    <span><strong>{{ file.fileName }}</strong><small>{{ formatBytes(file.sizeBytes) }}</small></span>
                  </a>
                  <span v-else class="attachment-link pending">
                    <span class="file-icon">▤</span>
                    <span><strong>{{ file.fileName }}</strong><small>等待上传</small></span>
                  </span>
                </div>
              </div>
            </div>
          </article>

          <div v-if="!snapshot.messages.length && !detailLoading" class="empty-state thread-empty">
            <span class="empty-glyph">□</span>
            <p>{{ hasKnownConversationActivity ? '消息内容尚未同步' : '暂无消息' }}</p>
          </div>
          <div v-if="detailLoading" class="loading-overlay"><span class="spinner" /></div>
        </div>

        <footer class="composer">
          <div v-if="staged.length" class="staged-files">
            <button v-for="(file, index) in staged" :key="file.id" type="button" @click="removeStaged(index)">
              {{ file.fileName }} <span>×</span>
            </button>
          </div>
          <div class="compose-surface">
            <textarea
              v-model="draft"
              :disabled="!canSendText"
              :maxlength="maxTextLength"
              :placeholder="canSendText ? '输入回复…' : '此接入仅接收消息'"
              rows="2"
              @keydown="onComposerKeydown"
            />
            <div class="compose-toolbar">
              <label class="quiet-button attachment-button"
                :class="{ disabled: !canSendFiles || uploadingConversationIds.has(selectedId) }" title="添加附件">
                ＋
                <input type="file" multiple :accept="fileAccept"
                  :disabled="!canSendFiles || uploadingConversationIds.has(selectedId)" @change="uploadFiles">
              </label>
              <span v-if="!canSendFiles && canSendText" class="capability-hint">不支持发送附件</span>
              <button class="accent-button" type="button" :disabled="!canSend" @click="send">发送</button>
            </div>
          </div>
        </footer>
      </template>

      <div v-else class="empty-state welcome-state">
        <span class="empty-glyph">□</span>
        <p>选择一个会话</p>
      </div>
    </section>

    <section v-else class="instances-pane">
      <header class="instances-header">
        <button class="quiet-button" type="button" aria-label="返回收件箱" title="返回收件箱" @click="showInstances = false">←</button>
        <h1>接入实例</h1>
      </header>
      <div class="instance-grid">
        <article v-for="connector in selectedConnector ? [selectedConnector] : []" :key="connector.id" class="instance-card">
          <header>
            <div>
              <p>{{ channelLabel(connector) }}</p>
              <h2>{{ connector.accountLabel }}</h2>
            </div>
            <span class="status-pill" :class="connector.state">
              <span class="presence-dot" :class="connector.state" />{{ statusLabel(connector.state) }}
            </span>
          </header>
          <dl>
            <dt>账号</dt><dd>{{ connector.accountLabel }}</dd>
            <dt>渠道</dt><dd>{{ channelLabel(connector) }}</dd>
            <dt>ID</dt><dd class="mono">{{ connector.id }}</dd>
            <dt>模式</dt><dd class="mono">{{ connector.mode }}</dd>
            <dt>能力</dt>
            <dd class="capability-list">
              <span v-for="capability in connector.capabilities" :key="capability">{{ capLabel(capability) }}</span>
              <span v-if="!connector.capabilities.length">未声明</span>
            </dd>
          </dl>
          <section v-if="supportsLayoutAutoRecovery(connector)" class="instance-control" aria-label="布局控制">
            <div class="instance-control-copy">
              <strong>自动恢复布局</strong>
              <span>{{ layoutControlStatus(connector) }}</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ checked: connectorLayoutControl(connector).enabled }"
              type="button"
              role="switch"
              :aria-checked="connectorLayoutControl(connector).enabled"
              :aria-label="`${connector.accountLabel} 自动恢复布局`"
              :disabled="updatingLayoutConnectorIds.has(connector.id)"
              @click="setLayoutAutoRecovery(connector, !connectorLayoutControl(connector).enabled)"
            >
              <span class="toggle-knob" />
            </button>
          </section>
        </article>
        <div v-if="!selectedConnector" class="empty-state"><span class="empty-glyph">□</span><p>尚无接入实例</p></div>
      </div>
    </section>
  </main>

  <Transition name="toast">
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
  </Transition>
</template>
