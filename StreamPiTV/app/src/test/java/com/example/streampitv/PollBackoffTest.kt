package com.example.streampitv

import com.example.streampitv.util.pollDelayMs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PollBackoffTest {

    @Test
    fun `a healthy poll runs at the base interval`() {
        assertEquals("no failures means no backoff", 5_000L, pollDelayMs(0, 5_000))
    }

    @Test
    fun `each consecutive failure doubles the wait`() {
        assertEquals(10_000L, pollDelayMs(1, 5_000))
        assertEquals(20_000L, pollDelayMs(2, 5_000))
    }

    @Test
    fun `backoff is capped`() {
        assertEquals("5s doubled three times is 40s, which must clamp", 30_000L, pollDelayMs(3, 5_000))
        assertEquals(30_000L, pollDelayMs(8, 5_000))
    }

    @Test
    fun `a long outage cannot overflow into a hot loop`() {
        // The regression this guards: an unclamped shift past 63 wraps Long negative, and
        // delay() returns immediately on a negative value — so the "backoff" would spin as fast
        // as the network allows, precisely when the server is already in trouble.
        for (failures in intArrayOf(20, 63, 64, 1_000, Int.MAX_VALUE)) {
            val delay = pollDelayMs(failures, 5_000)
            assertTrue("delay after $failures failures must stay positive, was $delay", delay > 0)
            assertEquals("and must sit at the cap", 30_000L, delay)
        }
    }

    @Test
    fun `a base longer than the cap is still bounded by the cap`() {
        assertEquals(30_000L, pollDelayMs(0, 60_000))
        assertEquals(30_000L, pollDelayMs(4, 60_000))
    }
}
