package app.codexweb.mobile;

import java.net.URI;
import java.util.Locale;

public final class ServerPolicy {
    private ServerPolicy() {}

    public static String normalize(String input) {
        try {
            URI uri = new URI(input.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535
                    || (uri.getRawPath() != null && uri.getRawPath().contains("%"))) {
                throw new IllegalArgumentException();
            }
            String path = uri.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/codex-web/";
            if (!path.endsWith("/")) path += "/";
            URI normalized = new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort(), path, null, null).normalize();
            if (!normalized.getPath().equals(path) || path.contains("//")) throw new IllegalArgumentException();
            return normalized.toASCIIString();
        } catch (Exception error) {
            throw new IllegalArgumentException("请输入有效的 HTTPS 服务地址，不要包含密码、查询参数或片段。", error);
        }
    }

    public static boolean sameOrigin(String server, String candidate) {
        try {
            URI base = new URI(server);
            URI uri = new URI(candidate);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo() == null
                    && base.getHost().equalsIgnoreCase(uri.getHost()) && port(base) == port(uri);
        } catch (Exception error) {
            return false;
        }
    }

    public static boolean inApp(String server, String candidate) {
        if (!sameOrigin(server, candidate)) return false;
        try {
            URI uri = new URI(candidate);
            String path = uri.getRawPath();
            String basePath = new URI(server).getRawPath();
            return path != null && !path.contains("%") && !path.contains("\\")
                    && uri.normalize().getRawPath().equals(path)
                    && (path.startsWith(basePath) || path.equals(basePath.substring(0, basePath.length() - 1)));
        } catch (Exception error) {
            return false;
        }
    }

    private static int port(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
}
