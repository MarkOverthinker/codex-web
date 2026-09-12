package app.codexweb.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val NativeLightColors = lightColorScheme(
    primary = Color(0xff354381),
    onPrimary = Color(0xffffffff),
    primaryContainer = Color(0xffe0e5ff),
    onPrimaryContainer = Color(0xff202b60),
    inversePrimary = Color(0xffbcc5ff),
    secondary = Color(0xff48516a),
    onSecondary = Color(0xffffffff),
    secondaryContainer = Color(0xffe8ecf5),
    onSecondaryContainer = Color(0xff28334a),
    tertiary = Color(0xff795000),
    onTertiary = Color(0xffffffff),
    tertiaryContainer = Color(0xfff0aa3c),
    onTertiaryContainer = Color(0xff261900),
    background = Color(0xfffafbff),
    onBackground = Color(0xff191b23),
    surface = Color(0xffffffff),
    onSurface = Color(0xff191b23),
    surfaceVariant = Color(0xffe5e7ef),
    onSurfaceVariant = Color(0xff505361),
    surfaceTint = Color(0xff354381),
    inverseSurface = Color(0xff2d2f38),
    inverseOnSurface = Color(0xfff2f1f8),
    error = Color(0xffa3262b),
    onError = Color(0xffffffff),
    errorContainer = Color(0xffffe0df),
    onErrorContainer = Color(0xff6e0e14),
    outline = Color(0xff727583),
    outlineVariant = Color(0xffc7cbd6),
    scrim = Color(0xff000000),
    surfaceBright = Color(0xfffafbff),
    surfaceDim = Color(0xffdbdde6),
    surfaceContainerLowest = Color(0xffffffff),
    surfaceContainerLow = Color(0xfff5f6fa),
    surfaceContainer = Color(0xffeff0f6),
    surfaceContainerHigh = Color(0xffe8eaf1),
    surfaceContainerHighest = Color(0xffe2e4ed),
    primaryFixed = Color(0xffe0e5ff),
    primaryFixedDim = Color(0xffbcc5ff),
    onPrimaryFixed = Color(0xff152052),
    onPrimaryFixedVariant = Color(0xff303f79),
    secondaryFixed = Color(0xffe8ecf5),
    secondaryFixedDim = Color(0xffbec7de),
    onSecondaryFixed = Color(0xff182338),
    onSecondaryFixedVariant = Color(0xff3a455d),
    tertiaryFixed = Color(0xffffdda6),
    tertiaryFixedDim = Color(0xfff0bd68),
    onTertiaryFixed = Color(0xff261900),
    onTertiaryFixedVariant = Color(0xff5d3d00),
)

internal val NativeDarkColors = darkColorScheme(
    primary = Color(0xffbcc5ff),
    onPrimary = Color(0xff222e61),
    primaryContainer = Color(0xff354381),
    onPrimaryContainer = Color(0xffe0e5ff),
    inversePrimary = Color(0xff354381),
    secondary = Color(0xffbec7de),
    onSecondary = Color(0xff293247),
    secondaryContainer = Color(0xff394258),
    onSecondaryContainer = Color(0xffe8ecf5),
    tertiary = Color(0xfff0bd68),
    onTertiary = Color(0xff422b00),
    tertiaryContainer = Color(0xff5d3d00),
    onTertiaryContainer = Color(0xffffdda6),
    background = Color(0xff17181c),
    onBackground = Color(0xffe5e5ec),
    surface = Color(0xff1d1e23),
    onSurface = Color(0xffe5e5ec),
    surfaceVariant = Color(0xff41434e),
    onSurfaceVariant = Color(0xffb9bbc8),
    surfaceTint = Color(0xffbcc5ff),
    inverseSurface = Color(0xffe5e5ec),
    inverseOnSurface = Color(0xff2d2f38),
    error = Color(0xffffb3b1),
    onError = Color(0xff680b13),
    errorContainer = Color(0xff842026),
    onErrorContainer = Color(0xffffe0df),
    outline = Color(0xff9295a3),
    outlineVariant = Color(0xff454752),
    scrim = Color(0xff000000),
    surfaceBright = Color(0xff393a42),
    surfaceDim = Color(0xff17181c),
    surfaceContainerLowest = Color(0xff111216),
    surfaceContainerLow = Color(0xff1d1e23),
    surfaceContainer = Color(0xff23242b),
    surfaceContainerHigh = Color(0xff2c2d35),
    surfaceContainerHighest = Color(0xff35363f),
    primaryFixed = Color(0xffe0e5ff),
    primaryFixedDim = Color(0xffbcc5ff),
    onPrimaryFixed = Color(0xff152052),
    onPrimaryFixedVariant = Color(0xff303f79),
    secondaryFixed = Color(0xffe8ecf5),
    secondaryFixedDim = Color(0xffbec7de),
    onSecondaryFixed = Color(0xff182338),
    onSecondaryFixedVariant = Color(0xff3a455d),
    tertiaryFixed = Color(0xffffdda6),
    tertiaryFixedDim = Color(0xfff0bd68),
    onTertiaryFixed = Color(0xff261900),
    onTertiaryFixedVariant = Color(0xff5d3d00),
)

internal data class NativeMessageColors(val container: Color, val content: Color, val quote: Color)

internal fun nativeMessageColors(colors: ColorScheme, user: Boolean): NativeMessageColors =
    if (user) NativeMessageColors(colors.primary, colors.onPrimary, colors.onPrimary)
    else NativeMessageColors(Color.Transparent, colors.onSurface, colors.onSurfaceVariant)

private fun nativeTextStyle(size: Int, lineHeight: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontFamily = FontFamily.SansSerif, fontWeight = weight, fontSize = size.sp, lineHeight = lineHeight.sp,
)

internal val NativeTypography = Typography(
    displayLarge = nativeTextStyle(57, 64),
    displayMedium = nativeTextStyle(45, 52),
    displaySmall = nativeTextStyle(36, 44),
    headlineLarge = nativeTextStyle(32, 40),
    headlineMedium = nativeTextStyle(28, 36),
    headlineSmall = nativeTextStyle(24, 32),
    titleLarge = nativeTextStyle(20, 28, FontWeight.SemiBold),
    titleMedium = nativeTextStyle(16, 24, FontWeight.SemiBold),
    titleSmall = nativeTextStyle(14, 20, FontWeight.SemiBold),
    bodyLarge = nativeTextStyle(16, 24),
    bodyMedium = nativeTextStyle(14, 20),
    bodySmall = nativeTextStyle(14, 20),
    labelLarge = nativeTextStyle(14, 20, FontWeight.Medium),
    labelMedium = nativeTextStyle(12, 16, FontWeight.Medium),
    labelSmall = nativeTextStyle(12, 16, FontWeight.Medium),
)

internal val NativeShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun NativeTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) NativeDarkColors else NativeLightColors,
        typography = NativeTypography,
        shapes = NativeShapes,
        content = content,
    )
}
