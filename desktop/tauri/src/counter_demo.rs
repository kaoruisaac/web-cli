use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

pub const ADDR: &str = "127.0.0.1:47631";
pub const HOST_NAME: &str = "com.example.native_counter";

#[derive(Debug, Deserialize, Serialize)]
struct Request {
    #[serde(default)]
    r#type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Response {
    pub ok: bool,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct CounterState {
    inner: Mutex<CounterInner>,
}

struct CounterInner {
    count: i64,
    subscribers: Vec<mpsc::Sender<Response>>,
}

pub fn start_counter_server_once() {
    thread::spawn(|| {
        if let Err(_err) = run_counter_server() {
            #[cfg(debug_assertions)]
            eprintln!("counter server stopped: {_err}");
        }
    });
}

fn run_counter_server() -> io::Result<()> {
    let listener = TcpListener::bind(ADDR)?;
    #[cfg(debug_assertions)]
    eprintln!("counter server listening on {ADDR}");

    let state = Arc::new(CounterState {
        inner: Mutex::new(CounterInner {
            count: 0,
            subscribers: Vec::new(),
        }),
    });

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(_err) = handle_tcp_client(stream, state) {
                        #[cfg(debug_assertions)]
                        eprintln!("client error: {_err}");
                    }
                });
            }
            Err(_err) => {
                #[cfg(debug_assertions)]
                eprintln!("connection failed: {_err}");
            }
        }
    }

    Ok(())
}

fn handle_tcp_client(stream: TcpStream, state: Arc<CounterState>) -> io::Result<()> {
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    let mut writer = stream;

    let mut line = String::new();
    reader.read_line(&mut line)?;

    let req: Request = match serde_json::from_str(line.trim()) {
        Ok(req) => req,
        Err(err) => {
            let res = Response {
                ok: false,
                count: state.current_count(),
                error: Some(err.to_string()),
            };
            return write_json_line(&mut writer, &res);
        }
    };

    if req.r#type == "subscribe" {
        return handle_subscription(writer, state);
    }

    let current = match req.r#type.as_str() {
        "increment" => state.increment_and_broadcast(),
        "get" => state.current_count(),
        _ => state.current_count(),
    };

    let res = Response {
        ok: true,
        count: current,
        error: None,
    };
    write_json_line(&mut writer, &res)
}

fn handle_subscription(mut writer: TcpStream, state: Arc<CounterState>) -> io::Result<()> {
    let (tx, rx) = mpsc::channel();
    let current = state.add_subscriber(tx);
    let initial = Response {
        ok: true,
        count: current,
        error: None,
    };
    write_json_line(&mut writer, &initial)?;

    while let Ok(res) = rx.recv() {
        write_json_line(&mut writer, &res)?;
    }

    Ok(())
}

impl CounterState {
    fn current_count(&self) -> i64 {
        self.inner.lock().unwrap().count
    }

    fn add_subscriber(&self, tx: mpsc::Sender<Response>) -> i64 {
        let mut inner = self.inner.lock().unwrap();
        let current = inner.count;
        inner.subscribers.push(tx);
        current
    }

    fn increment_and_broadcast(&self) -> i64 {
        let mut inner = self.inner.lock().unwrap();
        inner.count += 1;
        let current = inner.count;
        let res = Response {
            ok: true,
            count: current,
            error: None,
        };
        inner.subscribers.retain(|tx| tx.send(res.clone()).is_ok());
        current
    }
}

pub fn call_counter_server(kind: &str) -> Result<i64, String> {
    let req = Request {
        r#type: kind.into(),
    };
    let res = send_to_counter_server(&req);
    if res.ok {
        Ok(res.count)
    } else {
        Err(res
            .error
            .unwrap_or_else(|| "counter server error".to_string()))
    }
}

fn send_to_counter_server(req: &Request) -> Response {
    match TcpStream::connect(ADDR) {
        Ok(mut stream) => {
            let payload = match serde_json::to_string(req) {
                Ok(payload) => payload,
                Err(err) => {
                    return Response {
                        ok: false,
                        count: 0,
                        error: Some(err.to_string()),
                    };
                }
            };

            if let Err(err) = stream.write_all(format!("{}\n", payload).as_bytes()) {
                return Response {
                    ok: false,
                    count: 0,
                    error: Some(err.to_string()),
                };
            }

            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            if let Err(err) = reader.read_line(&mut line) {
                return Response {
                    ok: false,
                    count: 0,
                    error: Some(err.to_string()),
                };
            }

            serde_json::from_str::<Response>(&line).unwrap_or_else(|err| Response {
                ok: false,
                count: 0,
                error: Some(err.to_string()),
            })
        }
        Err(err) => Response {
            ok: false,
            count: 0,
            error: Some(format!(
                "Cannot connect to counter service at {ADDR}. Launch Native Counter Desktop first. Details: {err}"
            )),
        },
    }
}

fn stream_counter_subscription<F>(mut on_response: F) -> io::Result<()>
where
    F: FnMut(Response) -> io::Result<()>,
{
    let mut stream = TcpStream::connect(ADDR)?;
    let req = Request {
        r#type: "subscribe".into(),
    };
    let payload = serde_json::to_string(&req)?;
    stream.write_all(format!("{}\n", payload).as_bytes())?;

    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "counter subscription ended",
            ));
        }

        let res = serde_json::from_str::<Response>(&line).unwrap_or_else(|err| Response {
            ok: false,
            count: 0,
            error: Some(err.to_string()),
        });
        on_response(res)?;
    }
}

fn write_json_line<W: Write>(writer: &mut W, value: &Response) -> io::Result<()> {
    let json = serde_json::to_string(value)?;
    writer.write_all(json.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

pub fn run_chrome_native_host() -> io::Result<()> {
    let mut stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));

    loop {
        let mut len_buf = [0_u8; 4];
        if stdin.read_exact(&mut len_buf).is_err() {
            break;
        }

        let len = u32::from_le_bytes(len_buf) as usize;
        let mut msg_buf = vec![0_u8; len];
        stdin.read_exact(&mut msg_buf)?;

        let req: Request = serde_json::from_slice(&msg_buf).unwrap_or(Request {
            r#type: "get".into(),
        });
        if req.r#type == "subscribe" {
            let stdout = Arc::clone(&stdout);
            thread::spawn(move || {
                let result = stream_counter_subscription(|res| {
                    let mut stdout = stdout.lock().unwrap();
                    write_chrome_message(&mut *stdout, &res)
                });

                if let Err(err) = result {
                    let res = Response {
                        ok: false,
                        count: 0,
                        error: Some(format!(
                            "Cannot subscribe to counter service at {ADDR}. Launch Native Counter Desktop first. Details: {err}"
                        )),
                    };
                    if let Ok(mut stdout) = stdout.lock() {
                        let _ = write_chrome_message(&mut *stdout, &res);
                    }
                }
            });
        } else {
            let res = send_to_counter_server(&req);
            let mut stdout = stdout.lock().unwrap();
            write_chrome_message(&mut *stdout, &res)?;
        }
    }

    Ok(())
}

fn write_chrome_message<W: Write>(writer: &mut W, value: &Response) -> io::Result<()> {
    let payload = serde_json::to_vec(value)?;
    let len = payload.len() as u32;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}
