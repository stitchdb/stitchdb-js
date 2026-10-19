export type {
  Socket,
  SocketOptions,
  SocketState,
  SocketOnOpen,
  SocketOnError,
  SocketOnMessage,
  SocketOnClose,
  SocketStateChangeCallbacks,
  Channel,
  ChannelState,
  ChannelEvent,
  ChannelBindingCallback,
  ChannelFilterBindings,
  ChannelOnMessage,
  ChannelOnErrorCallback,
  PresenceState,
  Message,
  Params,
  Transport,
  Timer,
  Vsn,
  Encode,
  Decode,
  HeartbeatCallback,
  HeartbeatStatus,
} from '../../vendor/phoenix/index'

import type { Channel, PresenceState } from '../../vendor/phoenix/index'

export type Push = ReturnType<Channel['push']>
export type PresenceStates = Record<string, PresenceState>
