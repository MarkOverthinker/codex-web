package app.codexweb.mobile

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import org.junit.Assert.*
import org.junit.Test

class NativeThemeTest {
    private val themes = listOf("light" to NativeLightColors, "dark" to NativeDarkColors)

    private fun contrast(foreground: Color, background: Color): Double {
        val foregroundLuminance = foreground.compositeOver(background).luminance().toDouble()
        val backgroundLuminance = background.luminance().toDouble()
        return (maxOf(foregroundLuminance, backgroundLuminance) + .05) /
            (minOf(foregroundLuminance, backgroundLuminance) + .05)
    }

    private fun assertContrast(name: String, foreground: Color, background: Color, minimum: Double = 4.5) {
        val ratio = contrast(foreground, background)
        assertTrue("$name: $ratio must be at least $minimum", ratio >= minimum)
    }

    private fun surfaces(colors: ColorScheme) = with(colors) {
        listOf(background, surface, surfaceVariant, surfaceBright, surfaceDim, surfaceContainerLowest,
            surfaceContainerLow, surfaceContainer, surfaceContainerHigh, surfaceContainerHighest)
    }

    @Test fun bodyAndSecondaryTextMeetContrastOnEveryReadingSurface() {
        themes.forEach { (theme, colors) ->
            surfaces(colors).forEachIndexed { index, surface ->
                assertContrast("$theme body $index", colors.onSurface, surface)
                assertContrast("$theme secondary $index", colors.onSurfaceVariant, surface)
            }
            assertContrast("$theme background", colors.onBackground, colors.background)
            assertContrast("$theme selected task secondary", colors.onSurfaceVariant, colors.secondaryContainer)
            assertContrast("$theme selected task error", colors.error, colors.secondaryContainer)
        }
    }

    @Test fun actualMessageSurfaceAndQuoteColorsMeetContrast() {
        themes.forEach { (theme, colors) ->
            listOf(true, false).forEach { user ->
                val message = nativeMessageColors(colors, user)
                assertEquals(if (user) colors.primary else Color.Transparent, message.container)
                assertEquals(if (user) colors.onPrimary else colors.onSurfaceVariant, message.quote)
                assertEquals(1f, message.quote.alpha, 0f)
                val background = message.container.compositeOver(colors.background)
                assertContrast("$theme message user=$user content", message.content, background)
                assertContrast("$theme message user=$user quote", message.quote, background)
            }
        }
    }

    @Test fun semanticButtonsContainersAndInverseTextMeetContrast() {
        themes.forEach { (theme, colors) ->
            with(colors) {
                listOf(
                    "primary" to (onPrimary to primary),
                    "primary container" to (onPrimaryContainer to primaryContainer),
                    "secondary" to (onSecondary to secondary),
                    "secondary container" to (onSecondaryContainer to secondaryContainer),
                    "tertiary" to (onTertiary to tertiary),
                    "tertiary container" to (onTertiaryContainer to tertiaryContainer),
                    "error" to (onError to error),
                    "error container" to (onErrorContainer to errorContainer),
                    "inverse surface" to (inverseOnSurface to inverseSurface),
                    "inverse primary" to (inversePrimary to inverseSurface),
                ).forEach { (role, pair) -> assertContrast("$theme $role", pair.first, pair.second) }
                listOf(surface, background, surfaceContainerLow, secondaryContainer).forEachIndexed { index, base ->
                    assertContrast("$theme primary text $index", primary, base)
                    assertContrast("$theme error text $index", error, base)
                    assertContrast("$theme unread marker $index", tertiary, base, 3.0)
                }
                assertContrast("$theme outline", outline, surface, 3.0)
            }
        }
    }

    @Test fun fixedRolesRemainConsistentAndReadableInBothThemes() {
        val light = NativeLightColors
        themes.forEach { (theme, colors) ->
            with(colors) {
                listOf(
                    listOf(primaryFixed, primaryFixedDim, onPrimaryFixed, onPrimaryFixedVariant) to
                        listOf(light.primaryFixed, light.primaryFixedDim, light.onPrimaryFixed, light.onPrimaryFixedVariant),
                    listOf(secondaryFixed, secondaryFixedDim, onSecondaryFixed, onSecondaryFixedVariant) to
                        listOf(light.secondaryFixed, light.secondaryFixedDim, light.onSecondaryFixed, light.onSecondaryFixedVariant),
                    listOf(tertiaryFixed, tertiaryFixedDim, onTertiaryFixed, onTertiaryFixedVariant) to
                        listOf(light.tertiaryFixed, light.tertiaryFixedDim, light.onTertiaryFixed, light.onTertiaryFixedVariant),
                ).forEachIndexed { index, (roles, expected) ->
                    assertEquals(expected, roles)
                    roles.take(2).forEach { container -> roles.drop(2).forEach { foreground ->
                        assertContrast("$theme fixed family $index", foreground, container)
                    } }
                }
            }
        }
    }

    @Test fun readingRolesAreOpaqueAndDarkPanelsStayNeutral() {
        themes.forEach { (_, colors) ->
            (surfaces(colors) + listOf(colors.onSurface, colors.onSurfaceVariant, colors.onBackground)).forEach {
                assertEquals(1f, it.alpha, 0f)
            }
        }
        with(NativeDarkColors) {
            listOf(surfaceContainerLowest, surfaceContainerLow, surfaceContainer, surfaceContainerHigh,
                surfaceContainerHighest).forEach { color ->
                assertTrue(maxOf(color.red, color.green, color.blue) - minOf(color.red, color.green, color.blue) < .1f)
            }
            val levels = listOf(surfaceContainerLowest, surfaceContainerLow, surfaceContainer, surfaceContainerHigh, surfaceContainerHighest)
            levels.zipWithNext().forEach { (lower, higher) -> assertTrue(lower.luminance() < higher.luminance()) }
        }
    }

    @Test fun contrastCalculationUsesCompositedAlphaNotOpaqueRgb() {
        assertEquals(21.0, contrast(Color.Black, Color.White), .001)
        assertEquals(1.0, contrast(Color.Transparent, Color.White), .001)
        assertTrue(contrast(Color.Black.copy(alpha = .5f), Color.White) < 4.5)
    }

    @Test fun typographyUsesSpBaselinesWithoutTinyLabels() {
        with(NativeTypography) {
            assertEquals(16.sp, bodyLarge.fontSize)
            assertEquals(24.sp, bodyLarge.lineHeight)
            listOf(bodyMedium, bodySmall).forEach {
                assertEquals(14.sp, it.fontSize)
                assertEquals(20.sp, it.lineHeight)
            }
            assertEquals(20.sp, titleLarge.fontSize)
            assertEquals(28.sp, titleLarge.lineHeight)
            listOf(labelLarge, labelMedium, labelSmall).forEach {
                assertTrue(it.fontSize.isSp)
                assertTrue(it.fontSize.value >= 12f)
                assertTrue(it.lineHeight.value >= it.fontSize.value)
            }
        }
    }

    @Test fun cornerSizesUseDensityNotFontScale() {
        with(NativeShapes) {
            listOf(extraSmall to 8f, small to 12f, medium to 16f, large to 24f, extraLarge to 24f).forEach { (shape, size) ->
                listOf(shape.topStart, shape.topEnd, shape.bottomStart, shape.bottomEnd).forEach { corner ->
                    assertEquals(size, corner.toPx(Size(200f, 200f), Density(1f, fontScale = 2f)), 0f)
                    assertEquals(size * 2f, corner.toPx(Size(200f, 200f), Density(2f)), 0f)
                }
            }
        }
    }
}
