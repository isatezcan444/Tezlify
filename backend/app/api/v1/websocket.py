import json
import logging
from typing import List, Dict, Any, Set
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.user_connections: Dict[str, Set[WebSocket]] = {}
        self.socket_user_map: Dict[WebSocket, str] = {}

    async def connect(self, websocket: WebSocket, user_id: Any = None):
        await websocket.accept()
        self.active_connections.add(websocket)
        if user_id:
            uid_str = str(user_id)
            self.socket_user_map[websocket] = uid_str
            if uid_str not in self.user_connections:
                self.user_connections[uid_str] = set()
            self.user_connections[uid_str].add(websocket)
        logger.info(f"WebSocket client connected. Active: {len(self.active_connections)}, user: {user_id}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        uid_str = self.socket_user_map.pop(websocket, None)
        if uid_str and uid_str in self.user_connections:
            self.user_connections[uid_str].discard(websocket)
            if not self.user_connections[uid_str]:
                del self.user_connections[uid_str]
        logger.info(f"WebSocket client disconnected. Active: {len(self.active_connections)}")

    async def broadcast(self, message: Dict[str, Any], target_user_id: Any = None):
        """
        Broadcasts a JSON message.
        If target_user_id is provided or message has 'user_id', routes strictly to that tenant's sockets!
        Otherwise, broadcasts to all connected clients.
        """
        if not self.active_connections:
            return

        target_uid = target_user_id or message.get("user_id")
        payload = json.dumps(message, default=str)
        dead_connections = set()

        if target_uid:
            target_str = str(target_uid)
            recipients = list(self.user_connections.get(target_str, set()))
            for connection in recipients:
                try:
                    await connection.send_text(payload)
                except Exception as e:
                    logger.warning(f"Error sending message to websocket client: {e}")
                    dead_connections.add(connection)
        else:
            for connection in list(self.active_connections):
                try:
                    await connection.send_text(payload)
                except Exception as e:
                    logger.warning(f"Error sending message to websocket client: {e}")
                    dead_connections.add(connection)

        for dead in dead_connections:
            self.disconnect(dead)


ws_manager = ConnectionManager()

