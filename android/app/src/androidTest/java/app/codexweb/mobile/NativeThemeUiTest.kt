package app.codexweb.mobile

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeThemeUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun themeSwitchProvidesSemanticColorsTypographyAndShapes() {
        val dark = mutableStateOf(false)
        lateinit var colors: ColorScheme
        lateinit var typography: Typography
        lateinit var shapes: Shapes
        lateinit var textStyle: TextStyle
        compose.setContent {
            NativeTheme(darkTheme = dark.value) {
                val currentColors = MaterialTheme.colorScheme
                val currentTypography = MaterialTheme.typography
                val currentShapes = MaterialTheme.shapes
                val currentTextStyle = LocalTextStyle.current
                SideEffect {
                    colors = currentColors
                    typography = currentTypography
                    shapes = currentShapes
                    textStyle = currentTextStyle
                }
                Surface(Modifier.fillMaxSize()) { Text("主题正文") }
            }
        }
        listOf(false, true, false).forEach { darkTheme ->
            compose.runOnIdle { dark.value = darkTheme }
            compose.onNodeWithText("主题正文").assertIsDisplayed()
            compose.runOnIdle {
                val expected = if (darkTheme) NativeDarkColors else NativeLightColors
                assertEquals(expected.background, colors.background)
                assertEquals(expected.primary, colors.primary)
                assertEquals(expected.onSecondaryContainer, colors.onSecondaryContainer)
                assertEquals(expected.tertiaryContainer, colors.tertiaryContainer)
                assertEquals(expected.onErrorContainer, colors.onErrorContainer)
                assertEquals(expected.surfaceContainerHigh, colors.surfaceContainerHigh)
                assertEquals(NativeTypography, typography)
                assertEquals(NativeShapes, shapes)
                assertEquals(NativeTypography.bodyLarge.fontSize, textStyle.fontSize)
                assertEquals(NativeTypography.bodyLarge.lineHeight, textStyle.lineHeight)
                assertEquals(NativeTypography.bodyLarge.fontFamily, textStyle.fontFamily)
            }
        }
    }
}
