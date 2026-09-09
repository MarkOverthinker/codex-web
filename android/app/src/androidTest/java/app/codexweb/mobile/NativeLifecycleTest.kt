package app.codexweb.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeLifecycleTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun actualActivityRecreationKeepsNonSecretConnectionFields() {
        compose.onNodeWithTag("server").performTextReplacement("https://example.org")
        compose.onNodeWithTag("username").performTextInput("recreation-test")
        compose.onNodeWithTag("password").performTextInput("not-persisted")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("server").assertTextContains("https://example.org")
        compose.onNodeWithTag("username").assertTextContains("recreation-test")
        compose.onNodeWithTag("login").assertIsNotEnabled()
    }
}
