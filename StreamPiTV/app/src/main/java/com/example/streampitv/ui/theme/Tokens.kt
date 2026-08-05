package com.example.streampitv.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The app's colour vocabulary, mirroring the web client's design tokens in
 * `web_client/src/index.css` so the two front-ends read as one product.
 *
 * Previously these were ~30 hex literals inlined across eight files, and they had drifted:
 * the surfaces and greys were Tailwind's cool blue-greys (#111827 / #1F2937 / #9CA3AF)
 * while the web client had moved to a deliberately warm near-black scale. Background and
 * accent already agreed; everything else did not.
 *
 * Two additions the web tokens do not define, both for reasons specific to a 10-foot UI:
 *
 *  - [dangerText] — the web system only defines `--color-danger` for fills. At TV viewing
 *    distance #dc2626 as *text* on near-black is too dark to read, so destructive labels
 *    use a lighter tint.
 *  - [onAccent] — text drawn on top of a solid accent/white fill.
 *
 * Destructive controls follow the web system's intent rather than its literal values: quiet
 * by default, solid only when focused. On a TV, focus is the analogue of hover.
 */
object Tokens {
    /** Page background. */
    val bg = Color(0xFF0A0A0A)

    /** Cards and panels sitting on [bg]. */
    val surface = Color(0xFF151210)

    /** Rows and chips sitting on [surface]. */
    val surface2 = Color(0xFF1C1815)

    /** Hairlines, and the raised state of a focused row. */
    val border = Color(0xFF2A2420)

    /** Primary text. */
    val text = Color(0xFFF2F0ED)

    /** Secondary text: labels, captions. */
    val muted = Color(0xFF948D84)

    /** Tertiary text: hints that should recede until looked for. */
    val muted2 = Color(0xFF5C5650)

    /** Brand red. Reserved for the one primary action per screen and the active nav tab. */
    val accent = Color(0xFFDC2626)
    val accentHover = Color(0xFFB91C1C)

    /** 12% accent, for the selected-but-unfocused nav tab. */
    val accentSoft = Color(0x1FDC2626)

    /** Destructive fills. Same hue as [accent]; a second red would only add palette noise. */
    val danger = Color(0xFFDC2626)

    /** Legible red for destructive *text* on a dark surface. See class docs. */
    val dangerText = Color(0xFFF87171)

    /** Text/icons on a solid [accent] or white fill. */
    val onAccent = Color(0xFF0A0A0A)

    val success = Color(0xFF22C55E)
    val warning = Color(0xFFF59E0B)
    val info = Color(0xFF3B82F6)
}
