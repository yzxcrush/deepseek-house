package com.deepseekhouse.app.bot;

import java.io.IOException;

/** Bot API 业务错误（服务器明确返回错误而非网络失败）；message 已转中文且不含 token。 */
public final class BotException extends IOException {

    /** 服务器错误码（Telegram error_code / OneBot retcode / HTTP status）；0 表示未知。 */
    public final int code;

    public BotException(int code, String message) {
        super(message == null || message.trim().isEmpty() ? "Bot API 调用失败" : message);
        this.code = code;
    }
}
