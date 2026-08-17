package com.example.streampitv

import com.example.streampitv.data.KunjiFinalizeRequest
import com.example.streampitv.util.DeviceInfo
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The server destructures `device_type` from this body verbatim and derives the `deviceKind` the
 * web cast picker keys its icon off it. A camelCase rename would compile, serialise, and silently
 * put this TV back to appearing as an unnamed desktop — so the serialised keys are pinned here.
 *
 * DeviceInfo.name is deliberately not asserted: Build.MANUFACTURER is unmocked under plain JUnit.
 * Keeping TYPE a const is what makes the part that matters testable at all.
 */
class SessionDeviceTest {

    private val gson = Gson()

    @Test
    fun `the finalize body carries snake_case device fields`() {
        val json = gson.toJson(KunjiFinalizeRequest("sess-1", "sub-1", "Sony BRAVIA", DeviceInfo.TYPE))
        assertTrue("the server reads device_type, not deviceType", json.contains("\"device_type\""))
        assertTrue(json.contains("\"device\""))
        assertFalse("a camelCase key would be silently ignored", json.contains("\"deviceType\""))
    }

    @Test
    fun `the device type matches the servers exact-match arm`() {
        assertEquals("Android TV", DeviceInfo.TYPE)
    }

    @Test
    fun `omitting the device fields sends what an older server already expects`() {
        val json = gson.toJson(KunjiFinalizeRequest("sess-1", "sub-1"))
        assertFalse("Gson omits nulls, so the body is unchanged", json.contains("device"))
        assertTrue(json.contains("\"sessionId\""))
        assertTrue(json.contains("\"sub\""))
    }
}
