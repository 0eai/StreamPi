package com.example.streampitv

import com.example.streampitv.util.isSessionExpiry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The server deletes sessions after 7 days of inactivity and then 401s everything. The app used
 * to catch that, log it, and spin forever behind a stored token only a reinstall could clear.
 *
 * The subtlety worth a test is which 401s count: /api/auth/login also answers 401, for a wrong
 * password, and treating that as an expiring session would fire a sign-out on every typo at the
 * login screen.
 */
class SessionExpiryTest {

    @Test
    fun `a 401 on a credentialed request means the session is dead`() {
        assertTrue(
            "401 on a request that carried a token is exactly the expiry case",
            isSessionExpiry(401, hadAuthHeader = true)
        )
    }

    @Test
    fun `a 401 without a credential is a failed login, not an expiry`() {
        assertFalse(
            "/api/auth/login 401s on a wrong password and must not sign anyone out",
            isSessionExpiry(401, hadAuthHeader = false)
        )
    }

    @Test
    fun `other statuses are never an expiry`() {
        // 403 in particular: the server uses it for private-vault and permission denials, which
        // are legitimate answers to a perfectly valid session.
        assertFalse("403 is a permission denial, not a dead token", isSessionExpiry(403, true))
        assertFalse("404 is a missing route on an older server", isSessionExpiry(404, true))
        assertFalse("500 is a server fault", isSessionExpiry(500, true))
        assertFalse("503 is the busy/unavailable path", isSessionExpiry(503, true))
        assertFalse("a success is obviously not an expiry", isSessionExpiry(200, true))
    }
}
