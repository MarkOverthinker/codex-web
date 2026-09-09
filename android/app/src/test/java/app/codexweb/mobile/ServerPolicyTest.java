package app.codexweb.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerPolicyTest {
    private final String server = "https://example.org/codex-web/";

    @Test public void normalizesServerWithoutEmbeddingDeploymentDetails() {
        assertEquals(server, ServerPolicy.normalize(" https://EXAMPLE.org "));
        assertEquals(server, ServerPolicy.normalize("https://example.org/codex-web"));
        assertEquals("https://example.org:8443/custom/", ServerPolicy.normalize("https://example.org:8443/custom/"));
    }

    @Test public void rejectsUnsafeSetupAddresses() {
        for (String value : new String[]{"http://example.org", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.org", "https://example.org/?token=secret", "https://example.org/#a", "https://example.org:0", "https://example.org:99999", "https://example.org/a/../b", "https://example.org/%2f", "https://example.org/a//b"}) {
            assertThrows(value, IllegalArgumentException.class, () -> ServerPolicy.normalize(value));
        }
    }

    @Test public void isolatesOriginsAndAppPaths() {
        assertTrue(ServerPolicy.sameOrigin(server, "https://example.org:443/codex-web/api/files/1?download=1"));
        assertFalse(ServerPolicy.sameOrigin(server, "https://example.org.evil.test/codex-web/"));
        assertFalse(ServerPolicy.sameOrigin(server, "http://example.org/codex-web/"));
        assertFalse(ServerPolicy.sameOrigin(server, "https://example.org:8443/codex-web/"));
        assertFalse(ServerPolicy.sameOrigin(server, "https://user@example.org/codex-web/"));
        assertTrue(ServerPolicy.inApp(server, server + "api/files/1?download=1"));
        assertTrue(ServerPolicy.inApp(server, "https://example.org/codex-web"));
        assertFalse(ServerPolicy.inApp(server, "https://example.org/codex-web-other/"));
        assertFalse(ServerPolicy.inApp(server, server + "../other/"));
        assertFalse(ServerPolicy.inApp(server, server + "%2e%2e/other/"));
        assertFalse(ServerPolicy.inApp(server, "intent://evil"));
    }
}
