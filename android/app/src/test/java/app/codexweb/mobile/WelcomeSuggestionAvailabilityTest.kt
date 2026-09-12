package app.codexweb.mobile

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class WelcomeSuggestionAvailabilityTest(
    private val scenario: String,
    private val state: NativeState,
    private val recording: Boolean,
    private val expected: Boolean,
) {
    @Test fun onlyAnEditableEmptyNewChatAllowsSuggestions() {
        val composerBefore = state.composer
        assertEquals(scenario, expected, canUseWelcomeSuggestion(state, recording))
        assertEquals(composerBefore, state.composer)
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun cases(): Collection<Array<Any>> {
            val empty = NativeState(session = json("authenticated" to true))
            return listOf(
                arrayOf("empty", empty, false, true),
                arrayOf("cleared draft", empty.copy(composer = Composer(dirty = true, revision = 7)), false, true),
                arrayOf("text", empty.copy(composer = Composer(content = "保留草稿")), false, false),
                arrayOf("whitespace is still input", empty.copy(composer = Composer(content = " \n")), false, false),
                arrayOf("quote", empty.copy(composer = Composer(quote = "保留引用")), false, false),
                arrayOf("whitespace quote", empty.copy(composer = Composer(quote = " ")), false, false),
                arrayOf("source without excerpt", empty.copy(composer = Composer(source = json())), false, false),
                arrayOf("attachment", empty.copy(composer = Composer(files = listOf(json("id" to "file")))), false, false),
                arrayOf("connecting", empty.copy(connecting = true), false, false),
                arrayOf("busy", empty.copy(busy = true), false, false),
                arrayOf("sending", empty.copy(busy = true, operation = "send"), false, false),
                arrayOf("uploading", empty.copy(busy = true, operation = "upload"), false, false),
                arrayOf("transcribing", empty.copy(busy = true, operation = "voice"), false, false),
                arrayOf("uncertain send", empty.copy(sendUncertain = true), false, false),
                arrayOf("cached read only", empty.copy(detailFromCache = true), false, false),
                arrayOf("recording before transcription", empty, true, false),
                arrayOf("signed out", empty.copy(session = null), false, false),
                arrayOf("expired session", empty.copy(session = json("authenticated" to false)), false, false),
                arrayOf("conversation switched before click", empty.copy(selectedId = "another-task"), false, false),
            )
        }
    }
}
