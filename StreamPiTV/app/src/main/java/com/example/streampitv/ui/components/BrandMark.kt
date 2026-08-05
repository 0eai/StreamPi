package com.example.streampitv.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.example.streampitv.R
import com.example.streampitv.ui.theme.Tokens

/**
 * The brand lockup — circuit-π mark plus the "TV" wordmark.
 *
 * Proportions come from `tools/make_banner.py`, which renders the launcher banner, so the
 * in-app header and the launcher tile read as the same mark rather than two similar ones.
 * Its `TEXT_TO_MARK = 0.66` is a *drawn cap height* relative to the mark; `fontSize` is an
 * em size, so it is divided by Noto Sans' cap height (~0.714em) to land on the same height.
 * Its `GAP_FRAC` is a fraction of banner width, which works out to ~0.2 of the mark height.
 *
 * The wordmark is sized in `sp` from the mark's `dp` on purpose: a lockup has to stay locked,
 * so it must not rescale with the system font setting while the mark beside it stays put.
 */
private const val CAP_HEIGHT_EM = 0.714f
private const val TEXT_TO_MARK = 0.66f
private const val GAP_TO_MARK = 0.2f

@Composable
fun BrandMark(height: Dp = 44.dp, modifier: Modifier = Modifier) {
    val fontSize = (height.value * TEXT_TO_MARK / CAP_HEIGHT_EM).sp
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Image(
            painter = painterResource(R.drawable.streampi_logo),
            contentDescription = "StreamPi TV",
            contentScale = ContentScale.Fit,
            modifier = Modifier.height(height)
        )
        Spacer(Modifier.width(height * GAP_TO_MARK))
        Text(
            text = "TV",
            color = Tokens.text,
            fontSize = fontSize,
            lineHeight = fontSize,
            fontWeight = FontWeight.Bold,
            // Without both of these the line box carries font padding and default leading,
            // which centres the box rather than the glyphs and pushes "TV" visibly low.
            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                platformStyle = PlatformTextStyle(includeFontPadding = false),
                lineHeightStyle = LineHeightStyle(
                    alignment = LineHeightStyle.Alignment.Center,
                    trim = LineHeightStyle.Trim.Both
                )
            )
        )
    }
}
