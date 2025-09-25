# backend/sensors/manager.py
from __future__ import annotations
import os, json, asyncio, time
from dataclasses import dataclass, asdict
from typing import Optional, Callable, Dict, Any

# MQTT (async)
from asyncio_mqtt import Client, MqttError
# Serial (blocking -> run in thread)
import serial

@dataclass
class LocalSensors:
    tiltmeter: float = 15.0
    piezometer: float = 12.0
    vibration: float = 8.0
    crackmeter: float = 18.0
    status: str = "online"
    ts: float = 0.0  # epoch

class SensorManager:
    """
    Collects local sensor data from:
      - MQTT topic (JSON lines)
      - Serial port (one JSON per line)
    Keeps latest reading in memory and can notify listeners.
    """
    def __init__(self) -> None:
        self._latest: LocalSensors = LocalSensors(ts=time.time())
        self._lock = asyncio.Lock()
        self._on_update: Optional[Callable[[Dict[str, Any]], None]] = None
        self._tasks: list[asyncio.Task] = []

    # ---------- public ----------
    def set_on_update(self, cb: Callable[[Dict[str, Any]], None]):
        self._on_update = cb

    async def start(self):
        # create tasks conditionally
        if os.getenv("MQTT_HOST"):
            self._tasks.append(asyncio.create_task(self._mqtt_worker()))
        if os.getenv("SERIAL_PORT"):
            self._tasks.append(asyncio.create_task(self._serial_worker()))

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()

    async def snapshot(self) -> Dict[str, Any]:
        async with self._lock:
            return asdict(self._latest)

    # ---------- internals ----------
    async def _update_from_payload(self, payload: dict):
        # Accept keys: tiltmeter, piezometer, vibration, crackmeter, status
        async with self._lock:
            self._latest.tiltmeter   = float(payload.get("tiltmeter", self._latest.tiltmeter))
            self._latest.piezometer  = float(payload.get("piezometer", self._latest.piezometer))
            self._latest.vibration   = float(payload.get("vibration", self._latest.vibration))
            self._latest.crackmeter  = float(payload.get("crackmeter", self._latest.crackmeter))
            self._latest.status      = str(payload.get("status", self._latest.status))
            self._latest.ts          = time.time()

            data = asdict(self._latest)

        if self._on_update:
            # fire-and-forget
            try:
                self._on_update(data)
            except Exception:
                pass

    # ---- MQTT ----
    async def _mqtt_worker(self):
        host = os.getenv("MQTT_HOST")
        port = int(os.getenv("MQTT_PORT", "1883"))
        user = os.getenv("MQTT_USERNAME")
        pwd  = os.getenv("MQTT_PASSWORD")
        topic = os.getenv("MQTT_TOPIC", "mine/sensors")

        while True:
            try:
                async with Client(hostname=host, port=port, username=user, password=pwd) as client:
                    await client.subscribe(topic)
                    async with client.unfiltered_messages() as messages:
                        async for msg in messages:
                            try:
                                payload = json.loads(msg.payload.decode("utf-8").strip())
                                await self._update_from_payload(payload)
                            except Exception:
                                continue
            except MqttError:
                await asyncio.sleep(3)

    # ---- Serial (blocking loop in thread) ----
    def _serial_blocking_loop(self):
        port = os.getenv("SERIAL_PORT")
        baud = int(os.getenv("SERIAL_BAUD", "115200"))
        ser = serial.Serial(port=port, baudrate=baud, timeout=1)
        buf = b""
        while True:
            line = ser.readline()
            if not line:
                continue
            try:
                payload = json.loads(line.decode("utf-8").strip())
            except Exception:
                continue
            # hand off to asyncio
            asyncio.run_coroutine_threadsafe(self._update_from_payload(payload), asyncio.get_event_loop())

    async def _serial_worker(self):
        await asyncio.to_thread(self._serial_blocking_loop)
