use serde_json::{Value, json};
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::{
    err_to_string, parse_string_array_field, parse_string_field, PluginKind, PluginRuntimeState,
    RuntimeExecuteResult, RuntimeHealth,
};
use super::registry::{
    ensure_registry, load_registry, plugin_paths, resolve_entrypoint, resolve_plugin,
};

pub(super) struct RunningLlamafile {
    pub child: std::process::Child,
    pub endpoint: String,
}

fn default_llamafile_prompt(action: &str) -> String {
    match action {
        "soap" => concat!(
            "Convert the following clinical note into SOAP format.\n\n",
            "Use these section headers exactly:\n",
            "SUBJECTIVE:\n",
            "OBJECTIVE:\n",
            "ASSESSMENT:\n",
            "PLAN:\n\n",
            "Keep medical terminology accurate. ",
            "If information for a section is not available, ",
            "write \"Not documented.\" ",
            "Be concise but thorough. ",
            "Output only the SOAP note with no additional commentary or critique."
        )
        .to_string(),
        _ => "Correct grammar and punctuation while preserving clinical meaning.".to_string(),
    }
}

fn normalize_http_path(path: &str, default_path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return default_path.to_string();
    }
    if trimmed.starts_with('/') {
        return trimmed.to_string();
    }
    format!("/{trimmed}")
}

fn service_health_path(metadata: &Option<Value>) -> String {
    let configured = parse_string_field(metadata, "serviceHealthPath")
        .unwrap_or_else(|| "/health".to_string());
    normalize_http_path(&configured, "/health")
}

fn service_completion_path(metadata: &Option<Value>) -> String {
    let configured = parse_string_field(metadata, "serviceCompletionPath")
        .unwrap_or_else(|| "/completion".to_string());
    normalize_http_path(&configured, "/completion")
}

fn build_url(endpoint: &str, path: &str) -> String {
    let normalized = normalize_http_path(path, "/");
    format!("{endpoint}{normalized}")
}

fn service_start_args(metadata: &Option<Value>, port: u16) -> Vec<String> {
    let templates = parse_string_array_field(metadata, "serviceStartArgs")
        .unwrap_or_else(|| {
            vec![
                "--server".to_string(),
                "--port".to_string(),
                "{port}".to_string(),
                "--nobrowser".to_string(),
            ]
        });
    templates
        .into_iter()
        .map(|template| template.replace("{port}", &port.to_string()))
        .collect()
}

fn extract_completion_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(Value::as_object)
                        .and_then(|message| message.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
}

fn pick_open_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err_to_string)?;
    let port = listener.local_addr().map_err(err_to_string)?.port();
    Ok(port)
}

fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .build()
}

fn http_get(endpoint: &str, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let url = build_url(endpoint, path);
    let response = http_agent(timeout).get(&url).call();
    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().map_err(err_to_string)?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(error) => Err(err_to_string(error)),
    }
}

fn http_post_json(
    endpoint: &str,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let url = build_url(endpoint, path);
    let response = http_agent(timeout).post(&url).send_json(body.clone());
    match response {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().map_err(err_to_string)?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(error) => Err(err_to_string(error)),
    }
}

fn wait_for_service_ready(endpoint: &str, health_path: &str) -> Result<(), String> {
    let timeout = Duration::from_millis(1000);
    // ~90 seconds total (60 polls * 1.5s each)
    for _ in 0..60 {
        if let Ok((status, _)) = http_get(endpoint, health_path, timeout) {
            if status < 500 {
                return Ok(());
            }
        }
        sleep(Duration::from_millis(500));
    }
    Err(format!(
        "Llamafile service did not become ready at {endpoint}{health_path} within 90s"
    ))
}

pub(super) fn stop_service(
    running: &mut HashMap<String, RunningLlamafile>,
    plugin_id: &str,
) -> Result<(), String> {
    let Some(mut service) = running.remove(plugin_id) else {
        return Ok(());
    };
    let _ = service.child.kill();
    service.child.wait().map_err(err_to_string)?;
    Ok(())
}

pub(super) fn cleanup_service_if_exited(
    running: &mut HashMap<String, RunningLlamafile>,
    plugin_id: &str,
) -> Result<Option<i32>, String> {
    let Some(service) = running.get_mut(plugin_id) else {
        return Ok(None);
    };

    let exited = service.child.try_wait().map_err(err_to_string)?;
    if let Some(status) = exited {
        let code = status.code().unwrap_or(-1);
        running.remove(plugin_id);
        return Ok(Some(code));
    }
    Ok(None)
}

pub(super) fn service_start_blocking(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<RuntimeHealth, String> {
    let runtime_state = app.state::<PluginRuntimeState>();
    let paths = plugin_paths(app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, plugin_id) else {
        return Err(format!("Unknown pluginId: {plugin_id}"));
    };
    if plugin.kind != PluginKind::Llm {
        return Err(format!("Plugin {plugin_id} is not an LLM plugin"));
    }

    let entrypoint = resolve_entrypoint(app, &plugin.entrypoint_path)?;
    if !entrypoint.exists() {
        return Err(format!("Entrypoint not found: {}", entrypoint.display()));
    }

    let health_path = service_health_path(&plugin.metadata);
    let endpoint = {
        let mut running = runtime_state.lock_running();

        let _ = cleanup_service_if_exited(&mut running, plugin_id)?;
        if let Some(service) = running.get(plugin_id) {
            return Ok(RuntimeHealth {
                ready: true,
                running: true,
                message: format!("Service already running for {plugin_id}"),
                pid: Some(service.child.id()),
                endpoint: Some(service.endpoint.clone()),
            });
        }

        let port = pick_open_port()?;
        let endpoint = format!("http://127.0.0.1:{port}");
        let args = service_start_args(&plugin.metadata, port);
        let child = Command::new(&entrypoint)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(err_to_string)?;

        running.insert(
            plugin_id.to_string(),
            RunningLlamafile {
                child,
                endpoint: endpoint.clone(),
            },
        );
        endpoint
    };

    // Check for immediate crash before entering the long poll
    sleep(Duration::from_millis(500));
    {
        let mut running = runtime_state.lock_running();
        if let Some(exit_code) = cleanup_service_if_exited(&mut running, plugin_id)? {
            return Err(format!(
                "Llamafile process exited immediately (code {exit_code})"
            ));
        }
    }

    if let Err(error) = wait_for_service_ready(&endpoint, &health_path) {
        let mut running = runtime_state.lock_running();
        let _ = stop_service(&mut running, plugin_id);
        return Err(error);
    }

    let mut running = runtime_state.lock_running();
    let _ = cleanup_service_if_exited(&mut running, plugin_id)?;
    let Some(service) = running.get(plugin_id) else {
        return Err("Service failed to remain running".to_string());
    };

    Ok(RuntimeHealth {
        ready: true,
        running: true,
        message: format!("Service started for {plugin_id}"),
        pid: Some(service.child.id()),
        endpoint: Some(service.endpoint.clone()),
    })
}

pub(super) fn service_status_blocking(
    app: &AppHandle,
    plugin_id: &str,
    runtime_state: &PluginRuntimeState,
) -> Result<RuntimeHealth, String> {
    let paths = plugin_paths(app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, plugin_id) else {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: "Plugin not found".to_string(),
            pid: None,
            endpoint: None,
        });
    };
    let entrypoint = resolve_entrypoint(app, &plugin.entrypoint_path)?;
    if !entrypoint.exists() {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: format!("Entrypoint not found: {}", entrypoint.display()),
            pid: None,
            endpoint: None,
        });
    }

    let mut running = runtime_state.lock_running();
    if let Some(exit_code) = cleanup_service_if_exited(&mut running, plugin_id)? {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: format!("Service exited with code {exit_code}"),
            pid: None,
            endpoint: None,
        });
    }

    let Some(service) = running.get(plugin_id) else {
        return Ok(RuntimeHealth {
            ready: false,
            running: false,
            message: "Service is stopped".to_string(),
            pid: None,
            endpoint: None,
        });
    };

    Ok(RuntimeHealth {
        ready: true,
        running: true,
        message: format!("Service running for {plugin_id}"),
        pid: Some(service.child.id()),
        endpoint: Some(service.endpoint.clone()),
    })
}

pub(super) fn execute_blocking(
    app: &AppHandle,
    plugin_id: &str,
    action: &str,
    input: &str,
    prompt: Option<String>,
) -> Result<RuntimeExecuteResult, String> {
    let runtime_state = app.state::<PluginRuntimeState>();
    let paths = plugin_paths(app)?;
    ensure_registry(&paths)?;
    let state = load_registry(&paths)?;
    let Some(plugin) = resolve_plugin(&state, plugin_id) else {
        return Err(format!("Unknown pluginId: {plugin_id}"));
    };
    if plugin.kind != PluginKind::Llm {
        return Err(format!("Plugin {plugin_id} is not an LLM plugin"));
    }

    let endpoint = {
        let mut running = runtime_state.lock_running();
        if let Some(exit_code) = cleanup_service_if_exited(&mut running, plugin_id)? {
            return Err(format!("Service exited with code {exit_code}"));
        }

        let Some(service) = running.get(plugin_id) else {
            return Err(format!("Service is not running for plugin {plugin_id}"));
        };
        service.endpoint.clone()
    };

    let completion_path = service_completion_path(&plugin.metadata);
    let prompt = prompt.unwrap_or_else(|| default_llamafile_prompt(action));
    let full_prompt = format!("{prompt}\n\n{input}");
    let payload = if completion_path.starts_with("/v1/") {
        json!({
            "model": "local",
            "messages": [{ "role": "user", "content": full_prompt }],
            "temperature": 0.2,
            "max_tokens": 2048,
            "frequency_penalty": 1.3,
            "stop": ["<end_of_turn>"]
        })
    } else {
        json!({
            "prompt": full_prompt,
            "n_predict": 2048,
            "temperature": 0.2,
            "repeat_penalty": 1.3,
            "stop": ["<end_of_turn>", "\nCritique:", "\n**Critique"]
        })
    };

    let (status, response_text) = http_post_json(
        &endpoint,
        &completion_path,
        &payload,
        Duration::from_secs(90),
    )?;
    if status >= 400 {
        let trimmed = response_text.trim();
        let message = if trimmed.is_empty() {
            format!("Service request failed with HTTP {status}")
        } else {
            format!("Service request failed with HTTP {status}: {trimmed}")
        };
        return Err(message);
    }

    let payload: Value = serde_json::from_str(&response_text).map_err(err_to_string)?;
    let text = extract_completion_text(&payload)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Service response did not include text content".to_string())?;
    Ok(RuntimeExecuteResult { text })
}
