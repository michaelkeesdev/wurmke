const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const players = new Map();
const rooms = new Map();
const gameHistory = [];

const TILES = [
  { number: 21, worms: 1 },
  { number: 22, worms: 1 },
  { number: 23, worms: 1 },
  { number: 24, worms: 1 },
  { number: 25, worms: 2 },
  { number: 26, worms: 2 },
  { number: 27, worms: 2 },
  { number: 28, worms: 2 },
  { number: 29, worms: 3 },
  { number: 30, worms: 3 },
  { number: 31, worms: 3 },
  { number: 32, worms: 3 },
  { number: 33, worms: 4 },
  { number: 34, worms: 4 },
  { number: 35, worms: 4 },
  { number: 36, worms: 4 },
];

const DICE_FACES = ["1", "2", "3", "4", "5", "worm"];

function broadcast(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomId, data) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.forEach((playerId) => {
    const player = players.get(playerId);
    if (player && player.ws) {
      broadcast(player.ws, data);
    }
  });
}

function getGameStateForRoom(room) {
  return {
    tiles: room.game.tiles,
    playerStacks: room.game.playerStacks,
    currentPlayerId: room.game.currentPlayerId,
    turnState: room.game.turnState,
    players: room.players.map((pid) => ({
      id: pid,
      name: players.get(pid)?.name || "Unknown",
    })),
  };
}

function initializeGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const availableTiles = [...TILES];
  const playerStacks = {};
  room.players.forEach((pid) => {
    playerStacks[pid] = [];
  });

  room.game = {
    tiles: availableTiles,
    playerStacks,
    currentPlayerIndex: 0,
    currentPlayerId: room.players[0],
    turnState: {
      availableDice: 8,
      selectedFaces: [],
      currentScore: 0,
      hasWorm: false,
      rolledDice: [],
      faceCounts: {},
    },
  };

  room.status = "playing";
}

function calculateDiceValue(face) {
  return face === "worm" ? 5 : parseInt(face);
}

function processRoll(room, playerId) {
  const { turnState } = room.game;

  if (turnState.availableDice <= 0) {
    return { valid: false, error: "No dice available" };
  }

  const diceResults = [];
  for (let i = 0; i < turnState.availableDice; i++) {
    diceResults.push(DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)]);
  }

  const faceCounts = {};
  diceResults.forEach((face) => {
    faceCounts[face] = (faceCounts[face] || 0) + 1;
  });

  const availableFaces = Object.keys(faceCounts).filter(
    (face) => !turnState.selectedFaces.includes(face)
  );

  if (availableFaces.length === 0) {
    return { valid: true, bust: true, diceResults };
  }

  turnState.rolledDice = diceResults;
  turnState.faceCounts = faceCounts;

  return {
    valid: true,
    bust: false,
    diceResults,
    availableFaces,
    faceCounts,
  };
}

function selectDiceFace(room, face) {
  const { turnState } = room.game;

  if (turnState.selectedFaces.includes(face)) {
    return { valid: false, error: "Face already selected this turn" };
  }

  if (!turnState.rolledDice.includes(face)) {
    return { valid: false, error: "Face not in current roll" };
  }

  const count = turnState.rolledDice.filter((f) => f === face).length;
  const value = calculateDiceValue(face);
  const pointsGained = value * count;

  turnState.selectedFaces.push(face);
  turnState.currentScore += pointsGained;
  turnState.availableDice -= count;

  if (face === "worm") {
    turnState.hasWorm = true;
  }

  turnState.rolledDice = [];
  turnState.faceCounts = {};

  return { valid: true, count, value: pointsGained };
}

function endPlayerTurn(room, playerId) {
  const { game } = room;
  const { turnState } = game;

  if (!turnState.hasWorm) {
    if (game.playerStacks[playerId].length > 0) {
      const lostTile = game.playerStacks[playerId].pop();
      game.tiles.push(lostTile);
      game.tiles.sort((a, b) => a.number - b.number);
    }
  } else {
    const score = turnState.currentScore;

    if (score < 21) {
      if (game.playerStacks[playerId].length > 0) {
        const lostTile = game.playerStacks[playerId].pop();
        game.tiles.push(lostTile);
        game.tiles.sort((a, b) => a.number - b.number);
      }
    } else {
      let takenTile = null;

      const exactIndex = game.tiles.findIndex((t) => t.number === score);
      if (exactIndex !== -1) {
        takenTile = game.tiles.splice(exactIndex, 1)[0];
        game.playerStacks[playerId].push(takenTile);
      } else {
        let stolen = false;
        for (const [pid, stack] of Object.entries(game.playerStacks)) {
          if (pid !== playerId && stack.length > 0) {
            const topTile = stack[stack.length - 1];
            if (topTile.number === score) {
              stack.pop();
              game.playerStacks[playerId].push(topTile);
              stolen = true;
              break;
            }
          }
        }

        if (!stolen) {
          let bestIdx = -1;
          for (let i = game.tiles.length - 1; i >= 0; i--) {
            if (game.tiles[i].number < score) {
              bestIdx = i;
              break;
            }
          }

          if (bestIdx !== -1) {
            takenTile = game.tiles.splice(bestIdx, 1)[0];
            game.playerStacks[playerId].push(takenTile);
          } else if (game.playerStacks[playerId].length > 0) {
            const lostTile = game.playerStacks[playerId].pop();
            game.tiles.push(lostTile);
            game.tiles.sort((a, b) => a.number - b.number);
          }
        }
      }
    }
  }

  if (game.tiles.length === 0) {
    return { gameOver: true };
  }

  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % room.players.length;
  game.currentPlayerId = room.players[game.currentPlayerIndex];

  game.turnState = {
    availableDice: 8,
    selectedFaces: [],
    currentScore: 0,
    hasWorm: false,
    rolledDice: [],
    faceCounts: {},
  };

  return { gameOver: false };
}

function calculateWinner(room) {
  const { game } = room;
  let maxWorms = -1;
  let winnerId = null;

  for (const [playerId, stack] of Object.entries(game.playerStacks)) {
    const totalWorms = stack.reduce((sum, tile) => sum + tile.worms, 0);
    if (totalWorms > maxWorms) {
      maxWorms = totalWorms;
      winnerId = playerId;
    }
  }

  return { winnerId, worms: maxWorms };
}

wss.on("connection", (ws) => {
  console.log("New connection");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "register":
          const playerId = uuidv4();
          players.set(playerId, { id: playerId, name: data.name, ws });

          broadcast(ws, {
            type: "registered",
            playerId,
            name: data.name,
          });

          const roomsList = Array.from(rooms.values())
            .filter((r) => r.status === "waiting")
            .map((r) => ({
              id: r.id,
              name: r.name,
              playerCount: r.players.length,
              status: r.status,
            }));

          broadcast(ws, {
            type: "rooms_list",
            rooms: roomsList,
          });
          break;

        case "create_room":
          const roomId = uuidv4();
          const creator = players.get(data.playerId);

          if (!creator) {
            broadcast(ws, { type: "error", message: "Player not found" });
            return;
          }

          rooms.set(roomId, {
            id: roomId,
            name: data.roomName,
            host: data.playerId,
            players: [data.playerId],
            status: "waiting",
            game: null,
          });

          broadcast(ws, {
            type: "room_created",
            roomId,
            roomName: data.roomName,
          });

          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const roomsList = Array.from(rooms.values())
                .filter((r) => r.status === "waiting")
                .map((r) => ({
                  id: r.id,
                  name: r.name,
                  playerCount: r.players.length,
                  status: r.status,
                }));
              broadcast(client, { type: "rooms_list", rooms: roomsList });
            }
          });
          break;

        case "join_room":
          const room = rooms.get(data.roomId);
          const joiningPlayer = players.get(data.playerId);

          if (!room) {
            broadcast(ws, { type: "error", message: "Room not found" });
            return;
          }

          if (!joiningPlayer) {
            broadcast(ws, { type: "error", message: "Player not found" });
            return;
          }

          if (room.status !== "waiting") {
            broadcast(ws, { type: "error", message: "Game already started" });
            return;
          }

          if (room.players.length >= 7) {
            broadcast(ws, { type: "error", message: "Room is full" });
            return;
          }

          if (!room.players.includes(data.playerId)) {
            room.players.push(data.playerId);
          }

          broadcastToRoom(data.roomId, {
            type: "room_updated",
            room: {
              id: room.id,
              name: room.name,
              host: room.host,
              players: room.players.map((pid) => ({
                id: pid,
                name: players.get(pid)?.name || "Unknown",
              })),
              status: room.status,
            },
          });

          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const roomsList = Array.from(rooms.values())
                .filter((r) => r.status === "waiting")
                .map((r) => ({
                  id: r.id,
                  name: r.name,
                  playerCount: r.players.length,
                  status: r.status,
                }));
              broadcast(client, { type: "rooms_list", rooms: roomsList });
            }
          });
          break;

        case "start_game":
          const gameRoom = rooms.get(data.roomId);

          if (!gameRoom) {
            broadcast(ws, { type: "error", message: "Room not found" });
            return;
          }

          if (gameRoom.host !== data.playerId) {
            broadcast(ws, {
              type: "error",
              message: "Only host can start game",
            });
            return;
          }

          if (gameRoom.players.length < 2) {
            broadcast(ws, {
              type: "error",
              message: "Need at least 2 players",
            });
            return;
          }

          initializeGame(data.roomId);

          broadcastToRoom(data.roomId, {
            type: "game_started",
            game: getGameStateForRoom(gameRoom),
          });
          break;

        case "roll_dice":
          const rollRoom = rooms.get(data.roomId);

          if (!rollRoom || !rollRoom.game) {
            broadcast(ws, { type: "error", message: "Game not found" });
            return;
          }

          if (rollRoom.game.currentPlayerId !== data.playerId) {
            broadcast(ws, { type: "error", message: "Not your turn" });
            return;
          }

          const rollResult = processRoll(rollRoom, data.playerId);

          if (!rollResult.valid) {
            broadcast(ws, { type: "error", message: rollResult.error });
            return;
          }

          if (rollResult.bust) {
            const bustResult = endPlayerTurn(rollRoom, data.playerId);

            broadcastToRoom(data.roomId, {
              type: "turn_bust",
              playerName: players.get(data.playerId)?.name || "Unknown",
              gameState: getGameStateForRoom(rollRoom),
              gameOver: bustResult.gameOver,
            });

            if (bustResult.gameOver) {
              const winner = calculateWinner(rollRoom);
              const gameRecord = {
                roomName: rollRoom.name,
                date: new Date().toISOString(),
                winner: {
                  id: winner.winnerId,
                  name: players.get(winner.winnerId)?.name,
                  worms: winner.worms,
                },
                players: rollRoom.players.map((pid) => ({
                  id: pid,
                  name: players.get(pid)?.name,
                  worms: rollRoom.game.playerStacks[pid].reduce(
                    (sum, t) => sum + t.worms,
                    0
                  ),
                })),
              };
              gameHistory.push(gameRecord);

              broadcastToRoom(data.roomId, {
                type: "game_over",
                winner: gameRecord.winner,
                finalScores: gameRecord.players,
              });

              rollRoom.status = "finished";
            }
          } else {
            broadcastToRoom(data.roomId, {
              type: "dice_rolled",
              diceResults: rollResult.diceResults,
              availableFaces: rollResult.availableFaces,
              faceCounts: rollResult.faceCounts,
            });
          }
          break;

        case "select_face":
          const selectRoom = rooms.get(data.roomId);

          if (!selectRoom || !selectRoom.game) {
            broadcast(ws, { type: "error", message: "Game not found" });
            return;
          }

          if (selectRoom.game.currentPlayerId !== data.playerId) {
            broadcast(ws, { type: "error", message: "Not your turn" });
            return;
          }

          const selectResult = selectDiceFace(selectRoom, data.face);

          if (!selectResult.valid) {
            broadcast(ws, { type: "error", message: selectResult.error });
            return;
          }

          broadcastToRoom(data.roomId, {
            type: "face_selected",
            playerId: data.playerId,
            face: data.face,
            count: selectResult.count,
            value: selectResult.value,
            gameState: getGameStateForRoom(selectRoom),
          });
          break;

        case "claim_tile":
          const claimRoom = rooms.get(data.roomId);

          if (!claimRoom || !claimRoom.game) {
            broadcast(ws, { type: "error", message: "Game not found" });
            return;
          }

          if (claimRoom.game.currentPlayerId !== data.playerId) {
            broadcast(ws, { type: "error", message: "Not your turn" });
            return;
          }

          const { turnState } = claimRoom.game;

          if (!turnState.hasWorm || turnState.currentScore < 21) {
            broadcast(ws, { type: "error", message: "Cannot claim tile" });
            return;
          }

          if (turnState.availableDice > 0) {
            broadcast(ws, {
              type: "error",
              message: "Must use all dice first",
            });
            return;
          }

          const tileNumber = data.tileNumber;
          const tileIndex = claimRoom.game.tiles.findIndex(
            (t) => t.number === tileNumber
          );

          if (tileIndex === -1) {
            broadcast(ws, { type: "error", message: "Tile not found" });
            return;
          }

          if (tileNumber > turnState.currentScore) {
            broadcast(ws, { type: "error", message: "Tile value too high" });
            return;
          }

          const tile = claimRoom.game.tiles.splice(tileIndex, 1)[0];
          claimRoom.game.playerStacks[data.playerId].push(tile);

          const claimResult = endPlayerTurn(claimRoom, data.playerId);

          broadcastToRoom(data.roomId, {
            type: "turn_ended",
            playerName: players.get(data.playerId)?.name || "Unknown",
            gameState: getGameStateForRoom(claimRoom),
            gameOver: claimResult.gameOver,
          });

          if (claimResult.gameOver) {
            const winner = calculateWinner(claimRoom);
            const gameRecord = {
              roomName: claimRoom.name,
              date: new Date().toISOString(),
              winner: {
                id: winner.winnerId,
                name: players.get(winner.winnerId)?.name,
                worms: winner.worms,
              },
              players: claimRoom.players.map((pid) => ({
                id: pid,
                name: players.get(pid)?.name,
                worms: claimRoom.game.playerStacks[pid].reduce(
                  (sum, t) => sum + t.worms,
                  0
                ),
              })),
            };
            gameHistory.push(gameRecord);

            broadcastToRoom(data.roomId, {
              type: "game_over",
              winner: gameRecord.winner,
              finalScores: gameRecord.players,
            });

            claimRoom.status = "finished";
          }
          break;

        case "get_history":
          broadcast(ws, {
            type: "game_history",
            history: gameHistory,
          });
          break;

        case "leave_room":
          const leaveRoom = rooms.get(data.roomId);
          if (leaveRoom) {
            leaveRoom.players = leaveRoom.players.filter(
              (pid) => pid !== data.playerId
            );

            if (leaveRoom.players.length === 0) {
              rooms.delete(data.roomId);
            } else {
              broadcastToRoom(data.roomId, {
                type: "room_updated",
                room: {
                  id: leaveRoom.id,
                  name: leaveRoom.name,
                  host: leaveRoom.host,
                  players: leaveRoom.players.map((pid) => ({
                    id: pid,
                    name: players.get(pid)?.name || "Unknown",
                  })),
                  status: leaveRoom.status,
                },
              });
            }
          }
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
      broadcast(ws, { type: "error", message: "Server error" });
    }
  });

  ws.on("close", () => {
    for (const [playerId, player] of players.entries()) {
      if (player.ws === ws) {
        players.delete(playerId);

        for (const [roomId, room] of rooms.entries()) {
          if (room.players.includes(playerId)) {
            room.players = room.players.filter((pid) => pid !== playerId);

            if (room.players.length === 0) {
              rooms.delete(roomId);
            } else {
              broadcastToRoom(roomId, {
                type: "room_updated",
                room: {
                  id: room.id,
                  name: room.name,
                  host: room.host,
                  players: room.players.map((pid) => ({
                    id: pid,
                    name: players.get(pid)?.name || "Unknown",
                  })),
                  status: room.status,
                },
              });
            }
          }
        }
        break;
      }
    }
    console.log("Connection closed");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
