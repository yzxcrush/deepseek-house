package com.deepseekhouse.app.agent;

import java.io.File;
import java.io.IOException;

/**
 * 工作区路径白名单（SPEC N1）。
 *
 * <p>规则：</p>
 * <ol>
 *   <li>相对路径一律相对工作区根解析；绝对路径必须落在工作区根内。</li>
 *   <li>任何路径段出现 {@code ..} 都直接拒绝（即使最终仍在工作区内），防止穿越语义被滥用。</li>
 *   <li>用 {@link File#getCanonicalFile()} 消除 {@code .}/{@code ..}/symlink 后再做前缀匹配，
 *       因此指向工作区外的 symlink 会被拒绝。</li>
 *   <li>写操作额外禁止命中工作区根目录本身。</li>
 * </ol>
 *
 * <p>前缀匹配使用 canonical 路径 + {@link File#separator}，避免 {@code /a/workspace-evil}
 * 冒充 {@code /a/workspace}。</p>
 */
public final class PathPolicy {

    private final File root;
    private final String rootCanonical;

    public PathPolicy(File root) throws IOException {
        if (root == null) {
            throw new IOException("工作区根目录为空");
        }
        File canonical = root.getCanonicalFile();
        if (!canonical.isDirectory()) {
            throw new IOException("工作区根不是目录：" + canonical.getAbsolutePath());
        }
        this.root = canonical;
        this.rootCanonical = canonical.getCanonicalPath();
    }

    public File root() {
        return root;
    }

    public String rootPath() {
        return rootCanonical;
    }

    /** 路径是否被允许（只判断，不抛异常）。 */
    public boolean isAllowed(String rawPath) {
        try {
            resolve(rawPath);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 解析任意路径（读语义）。越界抛 {@link SecurityException}。 */
    public File resolve(String rawPath) {
        return resolveInternal(rawPath, false);
    }

    public File resolveForRead(String rawPath) {
        return resolveInternal(rawPath, true);
    }

    public File resolveForWrite(String rawPath) {
        return resolveInternal(rawPath, false);
    }

    /**
     * @param forRead 为 true 时允许空路径（代表工作区根，用于 list_dir）；
     *                为 false 时（写语义）空路径/Root 永远非法。
     */
    private File resolveInternal(String rawPath, boolean forRead) {
        String path = rawPath == null ? "" : rawPath.trim();
        if (path.isEmpty()) {
            if (forRead) {
                return root;
            }
            throw new SecurityException("写操作必须指定工作区内的文件路径");
        }
        if (path.indexOf('\u0000') >= 0) {
            throw new SecurityException("路径包含非法字符");
        }
        String unix = path.replace('\\', '/');
        String[] segments = unix.split("/");
        for (String segment : segments) {
            if ("..".equals(segment)) {
                throw new SecurityException("路径包含 .. 穿越，已被拒绝：" + path);
            }
        }
        File candidate = unix.startsWith("/") ? new File(unix) : new File(root, unix);
        File canonical;
        try {
            canonical = candidate.getCanonicalFile();
        } catch (IOException e) {
            // 极端情况下（无法规范化）保留 absolute 形式，后续前缀检查会更严格
            canonical = candidate.getAbsoluteFile();
        }
        if (!isUnderRoot(canonical)) {
            throw new SecurityException("路径越出工作区：" + path);
        }
        if (!forRead && canonical.equals(root)) {
            throw new SecurityException("不能把工作区根目录当作文件写入");
        }
        return canonical;
    }

    /** canonical 路径是否在根目录内（含根自身）；前缀必须带分隔符。 */
    public boolean isUnderRoot(File canonicalFile) {
        if (canonicalFile == null) {
            return false;
        }
        String candidate;
        try {
            candidate = canonicalFile.getCanonicalPath();
        } catch (IOException e) {
            candidate = canonicalFile.getAbsolutePath();
        }
        return candidate.equals(rootCanonical) || candidate.startsWith(rootCanonical + File.separator);
    }

    /** 工作区内的相对路径（用于展示/回传给 JS）；根返回 "."。 */
    public String relativePath(File file) {
        if (file == null) {
            return "";
        }
        try {
            File canonical = file.getCanonicalFile();
            String path = canonical.getCanonicalPath();
            if (path.equals(rootCanonical)) {
                return ".";
            }
            if (path.startsWith(rootCanonical + File.separator)) {
                return path.substring(rootCanonical.length() + 1)
                        .replace(File.separatorChar, '/');
            }
            return path;
        } catch (Throwable t) {
            return file.getAbsolutePath();
        }
    }
}
