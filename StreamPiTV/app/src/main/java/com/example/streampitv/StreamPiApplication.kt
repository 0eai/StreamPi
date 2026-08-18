package com.example.streampitv

import android.app.Application
import android.graphics.Bitmap
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache

/**
 * Coil is configured explicitly rather than left on its defaults because the target hardware is
 * a Fire TV Stick 4K Max: 2 GB of RAM shared with Fire OS, which users routinely see sitting
 * under 500 MB free. Home renders a 5-wide grid of posters, and on the default settings some of
 * them silently never appear — a failed decode in Coil draws nothing, so it reads as a missing
 * poster rather than an error.
 *
 * Every setting here trades a feature this app does not need for headroom it does:
 *
 *  - allowHardware(false): hardware bitmaps live in graphics memory and consume a file
 *    descriptor each, and the supply of both is small on a stick. They buy nothing for a wall of
 *    320px-wide thumbnails, and exhausting either is a documented cause of images quietly
 *    failing to load on constrained devices.
 *  - RGB_565: halves the bytes per bitmap versus ARGB_8888. These posters are opaque JPEG
 *    frames, so there is no alpha channel to lose.
 *  - a deliberately small memory cache, because the disk cache below is what should absorb
 *    scrolling — not the heap.
 *  - a real disk cache with respectCacheHeaders(false): the poster route sends no caching
 *    headers, so by default Coil re-fetches every thumbnail over the network on each launch.
 *    Against a Raspberry Pi on a home connection that is the slow part, not decoding.
 */
class StreamPiApplication : Application(), ImageLoaderFactory {

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .allowHardware(false)
            .bitmapConfig(Bitmap.Config.RGB_565)
            .memoryCache {
                MemoryCache.Builder(this)
                    .maxSizePercent(0.15)
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("poster_cache"))
                    .maxSizeBytes(96L * 1024 * 1024)
                    .build()
            }
            .respectCacheHeaders(false)
            .build()
}
