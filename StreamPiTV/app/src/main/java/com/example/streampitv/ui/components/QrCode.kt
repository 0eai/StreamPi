package com.example.streampitv.ui.components

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * Renders a string as a QR bitmap.
 *
 * Deliberately black-on-white with a quiet zone: phone scanners need the light background
 * and the margin, so this must not be drawn inverted to match the dark TV theme.
 *
 * The kunji payload is "K1:" + base32, which lives entirely inside the QR alphanumeric
 * charset. zxing picks that mode automatically and packs it far tighter than byte mode
 * would, which buys enough headroom to run error correction at M rather than L — worth it
 * for a code being photographed off a screen at an angle.
 *
 * [sizePx] should be the on-screen size in *pixels*, not dp. QRCodeWriter fits the modules
 * to an integer pixel multiple, so matching the bitmap to the final draw size means no
 * rescaling and therefore no blurred module edges — which matters more than raw dimensions
 * when the phone is across the room.
 */
fun qrBitmap(content: String, sizePx: Int = 640): Bitmap {
    // CHARACTER_SET only affects byte mode, so it is inert for alphanumeric content and
    // adds no ECI header here. Kept as a safety net in case a caller passes other text.
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.MARGIN to 2,
        EncodeHintType.CHARACTER_SET to "UTF-8"
    )
    val side = sizePx.coerceAtLeast(64)
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, side, side, hints)
    val pixels = IntArray(side * side)
    for (y in 0 until side) {
        val row = y * side
        for (x in 0 until side) {
            pixels[row + x] = if (matrix[x, y]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }
    }
    return Bitmap.createBitmap(side, side, Bitmap.Config.RGB_565).apply {
        setPixels(pixels, 0, side, 0, 0, side, side)
    }
}

@Composable
fun rememberQrImage(content: String, sizePx: Int = 640): ImageBitmap =
    remember(content, sizePx) { qrBitmap(content, sizePx).asImageBitmap() }
