// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { sendMessage as sendMessageApi } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import { generateId } from "../random.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";

export type SendTextOptions = WeixinApiOptions & {
  contextToken?: string;
  runId?: string;
};

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, runId, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
      run_id: runId ?? undefined,
    },
  };
}

/** Send a plain text message downstream. */
export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateId("iclaw");
  const req = buildTextMessageReq({ to, text, contextToken: opts.contextToken, runId: opts.runId, clientId });
  await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, timeoutMs: opts.timeoutMs, body: req });
  return { messageId: clientId };
}
