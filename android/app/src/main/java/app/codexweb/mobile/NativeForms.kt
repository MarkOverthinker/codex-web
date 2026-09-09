@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.codexweb.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject

data class FormField(val key: String, val label: String, val value: String = "", val kind: String = "text", val required: Boolean = false)
data class FormRequest(val title: String, val fields: List<FormField>, val explanation: String = "", val submit: (JSONObject) -> Unit)

fun parseForm(fields: List<FormField>, values: Map<String, String>): JSONObject = JSONObject().apply {
    fields.forEach { field ->
        val value = values[field.key].orEmpty()
        require(!field.required || value.isNotBlank()) { "请填写${field.label}" }
        when (field.kind) {
            "secret" -> if (value.isNotEmpty()) put(field.key, value)
            "number" -> if (value.isNotBlank()) {
                val parsed = value.toDoubleOrNull()
                require(parsed != null && parsed.isFinite()) { "${field.label}必须是数字" }
                put(field.key, parsed)
            }
            "int" -> if (value.isNotBlank()) put(field.key, value.toIntOrNull() ?: throw IllegalArgumentException("${field.label}必须是整数"))
            "bool" -> put(field.key, value == "true")
            "lines" -> put(field.key, value.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }.jsonArray())
            "numbers" -> put(field.key, value.split(',', '\n').filter { it.isNotBlank() }.map { it.trim().toInt() }.jsonArray())
            else -> put(field.key, value)
        }
    }
}

@Composable
fun NativeForm(title: String, fields: List<FormField>, explanation: String = "", busy: Boolean = false, extra: @Composable () -> Unit = {},
               onDismiss: () -> Unit, onSave: (JSONObject) -> Unit) {
    val values = remember(title) { mutableStateMapOf<String, String>().apply { fields.forEach { put(it.key, it.value) } } }
    var error by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) {
            Scaffold(Modifier.imePadding(), topBar = {
                TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = onDismiss, enabled = !busy) { Icon(Icons.Outlined.Close, "取消") } },
                    actions = { TextButton(enabled = !busy, onClick = {
                        try { val payload = parseForm(fields, values); onSave(payload) } catch (reason: Exception) { error = reason.message }
                    }) { Text("保存") } })
            }) { padding ->
                Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (explanation.isNotBlank()) Text(explanation, style = MaterialTheme.typography.bodyMedium)
                    fields.forEach { field ->
                        if (field.kind == "bool") Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(field.label, Modifier.weight(1f))
                            Switch(values[field.key] == "true", onCheckedChange = { values[field.key] = it.toString() }, enabled = !busy)
                        } else OutlinedTextField(value = values[field.key].orEmpty(), onValueChange = { values[field.key] = it }, label = { Text(field.label) },
                            modifier = Modifier.fillMaxWidth(), enabled = !busy, minLines = if (field.kind == "multiline") 6 else 1,
                            maxLines = if (field.kind in listOf("multiline", "lines")) 12 else 1,
                            singleLine = field.kind !in listOf("multiline", "lines"),
                            visualTransformation = if (field.kind == "secret") PasswordVisualTransformation() else VisualTransformation.None,
                            keyboardOptions = KeyboardOptions(keyboardType = when (field.kind) {
                                "secret" -> KeyboardType.Password
                                "number" -> KeyboardType.Decimal
                                "int" -> KeyboardType.Number
                                else -> KeyboardType.Text
                            }))
                    }
                    extra()
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}

@Composable
fun ChoiceField(label: String, value: String, options: List<Pair<String, String>>, choose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    val current = options.find { it.first == value }?.second ?: value.ifBlank { "默认" }
    Row(modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
        .clickable { expanded = true }
        .testTag("choice-$label"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(current, Modifier.padding(top = 2.dp), fontSize = 15.sp, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
        Icon(Icons.Outlined.ChevronRight, contentDescription = "选择$label", tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (expanded) AlertDialog(onDismissRequest = { expanded = false }, title = { Text(label) },
        text = {
            Column(Modifier.heightIn(max = 460.dp)) {
                if (options.size > 8) OutlinedTextField(search, { search = it }, label = { Text("搜索") }, singleLine = true)
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    options.filter { it.second.contains(search, true) }.forEach { (id, title) ->
                        Row(modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .clickable { expanded = false; choose(id) }
                            .testTag("choice-option-$id"), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = id == value, onClick = null)
                            Text(title, Modifier.padding(start = 10.dp), maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        }
                    }
                    if (options.isEmpty()) Text("服务器未提供可选项")
                }
            }
        }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("关闭") } })
}
