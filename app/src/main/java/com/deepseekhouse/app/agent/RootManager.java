package com.deepseekhouse.app.agent;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

/**
 * Root 检测与命令包装（App 可选 root 模式）。
 *
 * <p>使用 {@code /system/bin/su -c <cmd>} 执行；是否需要 KernelSU/Magisk 授权
 * 由系统 root 管理器决定，本类只负责探测与执行。</p>
 */
public final class RootManager {

    public static final String SU = "/system/bin/su";
    private static final long CHECK_TIMEOUT_MS = 4000L;

    private RootManager() {
    }

    /** 检测结果。 */
    public static final class Check {
        public final boolean root;
        public final int uid;
        public final String message;

        Check(boolean root, int uid, String message) {
            this.root = root;
            this.uid = uid;
            this.message = message == null ? "" : message;
        }
    }

    /** 执行 {@code su -c id} 探测 root；失败不抛异常。 */
    public static Check check() {
        Process process = null;
        try {
            process = new ProcessBuilder(SU, "-c", "id").redirectErrorStream(true).start();
            final ByteArrayOutputStream out = new ByteArrayOutputStream();
            final InputStream in = process.getInputStream();
            final Thread reader = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        byte[] buf = new byte[2048];
                        int n;
                        while ((n = in.read(buf)) >= 0) {
                            out.write(buf, 0, n);
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        try { in.close(); } catch (Throwable ignored) { }
                    }
                }
            }, "dsh-root-check");
            reader.setDaemon(true);
            reader.start();
            long deadline = System.currentTimeMillis() + CHECK_TIMEOUT_MS;
            boolean exited = false;
            while (System.currentTimeMillis() < deadline) {
                try {
                    process.exitValue();
                    exited = true;
                    break;
                } catch (IllegalThreadStateException running) {
                    try { Thread.sleep(50L); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            if (!exited) {
                try { process.destroy(); } catch (Throwable ignored) { }
                return new Check(false, -1, "检测超时：请在 KernelSU/Magisk 中授予 root 权限后重试");
            }
            reader.join(500L);
            String text = new String(out.toByteArray(), StandardCharsets.UTF_8).trim();
            int uid = -1;
            int idx = text.indexOf("uid=");
            if (idx >= 0) {
                int start = idx + 4;
                int end = start;
                while (end < text.length() && Character.isDigit(text.charAt(end))) {
                    end++;
                }
                if (end > start) {
                    try { uid = Integer.parseInt(text.substring(start, end)); } catch (Throwable ignored) { }
                }
            }
            boolean root = uid == 0;
            String message = root ? "已获得 root 权限（uid=0）"
                    : (text.isEmpty() ? "未获得 root 权限：请在 KernelSU/Magisk 中允许本应用"
                    : "未获得 root 权限：" + firstLine(text));
            return new Check(root, uid, message);
        } catch (Throwable t) {
            return new Check(false, -1, "无法执行 su：" + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()));
        } finally {
            if (process != null) {
                try { process.destroy(); } catch (Throwable ignored) { }
            }
        }
    }

    /** 检测结果 JSON：{root,uid,message}。 */
    public static String checkJson() {
        Check check = check();
        try {
            JSONObject json = new JSONObject();
            json.put("root", check.root);
            json.put("uid", check.uid);
            json.put("message", check.message);
            return json.toString();
        } catch (Throwable t) {
            return "{\"root\":false,\"uid\":-1,\"message\":\"检测失败\"}";
        }
    }

    /** 以 root 执行命令的 ProcessBuilder。 */
    public static ProcessBuilder rootProcessBuilder(String command) {
        return new ProcessBuilder(SU, "-c", command == null ? "" : command);
    }

    private static String firstLine(String text) {
        int newline = text.indexOf('\n');
        String line = newline >= 0 ? text.substring(0, newline) : text;
        return line.length() > 160 ? line.substring(0, 160) : line;
    }
}
