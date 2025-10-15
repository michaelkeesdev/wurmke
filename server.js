const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static("public"));

// Game state
const players = new Map(); // playerId -> { id, name, ws }
const rooms = new Map(); // roomId -> { id, name, host, players, status, game }
const gameHistory = []; // Array of completed games

// Regenwormen tiles (21-36, each with worm value)
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

// Dice faces: 1, 2, 3, 4, 5, worm (worm = 5 points)
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
      rollId: uuidv4(),
      availableDice: 8,
      selectedFaces: [],
      currentScore: 0,
      hasWorm: false,
      rolledDice: [],
    },
  };

  room.status = "playing";
}

function calculateDiceValue(face) {
  if (face === "worm") return 5;
  return parseInt(face);
}

function processRoll(room, diceResults) {
  const { turnState } = room.game;

  // Verify dice count matches available dice
  if (diceResults.length !== turnState.availableDice) {
    return { valid: false, error: "Invalid dice count" };
  }

  // Group dice by face
  const faceCounts = {};
  diceResults.forEach((face) => {
    faceCounts[face] = (faceCounts[face] || 0) + 1;
  });

  // Check if player can select any face (not already selected)
  const availableFaces = Object.keys(faceCounts).filter(
    (face) => !turnState.selectedFaces.includes(face)
  );

  if (availableFaces.length === 0) {
    // Bust! Player loses their turn and must return highest tile
    return { valid: true, bust: true };
  }

  turnState.rolledDice = diceResults;
  turnState.faceCounts = faceCounts;
  return { valid: true, bust: false, availableFaces, faceCounts };
}

function selectDiceFace(room, face) {
  const { turnState } = room.game;
  if (turnState.selectedFaces.includes(face)) {
    return { valid: false, error: "Face already selected" };
  }
  if (!turnState.rolledDice.includes(face)) {
    return { valid: false, error: "Face not in current roll" };
  }
  const count = turnState.rolledDice.filter((f) => f === face).length;
  const value = calculateDiceValue(face);
  turnState.selectedFaces.push(face);
  turnState.currentScore += value * count;
  turnState.availableDice -= count;
  if (face === "worm") {
    turnState.hasWorm = true;
  }
  turnState.rollId = uuidv4(); // Nieuw rollId voor de volgende worp
  turnState.rolledDice = []; // Leeg de gerolde dobbelstenen voor de volgende worp
  console.log(
    `Face '${face}' geselecteerd. Nieuwe score: ${turnState.currentScore}. Blijf rollen!`
  );
  return { valid: true, count, value: value * count };
}

function endTurn(room, playerId) {
  const { game } = room;
  const { turnState } = game;

  // Must have at least one worm to claim a tile
  if (!turnState.hasWorm) {
    // Lose highest tile if any
    if (game.playerStacks[playerId].length > 0) {
      const lostTile = game.playerStacks[playerId].pop();
      game.tiles.push(lostTile);
      game.tiles.sort((a, b) => a.number - b.number);
    }
  } else {
    const score = turnState.currentScore;

    // Can only take tile if score is 21 or higher
    if (score < 21) {
      // Can't take anything, lose highest tile
      if (game.playerStacks[playerId].length > 0) {
        const lostTile = game.playerStacks[playerId].pop();
        game.tiles.push(lostTile);
        game.tiles.sort((a, b) => a.number - b.number);
      }
    } else {
      // Try to take tile from middle with exact score
      const tileIndex = game.tiles.findIndex((t) => t.number === score);
      if (tileIndex !== -1) {
        const tile = game.tiles.splice(tileIndex, 1)[0];
        game.playerStacks[playerId].push(tile);
      } else {
        // Try to steal from another player (top tile with exact value = score)
        let stolenFrom = null;
        let stolenTile = null;

        for (const [pid, stack] of Object.entries(game.playerStacks)) {
          if (pid !== playerId && stack.length > 0) {
            const topTile = stack[stack.length - 1];
            if (topTile.number === score) {
              stolenTile = topTile;
              stolenFrom = pid;
              break;
            }
          }
        }

        if (stolenTile && stolenFrom) {
          game.playerStacks[stolenFrom].pop();
          game.playerStacks[playerId].push(stolenTile);
        } else {
          // Try to take highest available tile lower than score
          let bestTile = null;
          let bestIndex = -1;

          for (let i = game.tiles.length - 1; i >= 0; i--) {
            if (game.tiles[i].number < score) {
              bestTile = game.tiles[i];
              bestIndex = i;
              break;
            }
          }

          if (bestTile) {
            game.tiles.splice(bestIndex, 1);
            game.playerStacks[playerId].push(bestTile);
          } else {
            // Can't take anything, lose highest tile
            if (game.playerStacks[playerId].length > 0) {
              const lostTile = game.playerStacks[playerId].pop();
              game.tiles.push(lostTile);
              game.tiles.sort((a, b) => a.number - b.number);
            }
          }
        }
      }
    }
  }

  // Check if game is over (no tiles left)
  if (game.tiles.length === 0) {
    return { gameOver: true };
  }

  // Move to next player
  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % room.players.length;
  game.currentPlayerId = room.players[game.currentPlayerIndex];

  // Reset turn state
  game.turnState = {
    rollId: uuidv4(),
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

          // Send rooms list
          const roomsList = Array.from(rooms.values()).map((r) => ({
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
          const player = players.get(data.playerId);

          if (!player) {
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

          // Broadcast updated rooms list
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const roomsList = Array.from(rooms.values()).map((r) => ({
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

          // Broadcast updated rooms list
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              const roomsList = Array.from(rooms.values()).map((r) => ({
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

          if (gameRoom.players.length < 3) {
            broadcast(ws, {
              type: "error",
              message: "Need at least 3 players",
            });
            return;
          }

          initializeGame(data.roomId);

          broadcastToRoom(data.roomId, {
            type: "game_started",
            game: {
              tiles: gameRoom.game.tiles,
              playerStacks: gameRoom.game.playerStacks,
              currentPlayerId: gameRoom.game.currentPlayerId,
              turnState: gameRoom.game.turnState,
              players: gameRoom.players.map((pid) => ({
                id: pid,
                name: players.get(pid)?.name || "Unknown",
              })),
            },
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

          if (data.rollId !== rollRoom.game.turnState.rollId) {
            broadcast(ws, { type: "error", message: "Invalid roll ID" });
            return;
          }

          // Generate dice roll
          const diceCount = rollRoom.game.turnState.availableDice;
          const diceResults = [];
          for (let i = 0; i < diceCount; i++) {
            diceResults.push(
              DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)]
            );
          }

          const rollResult = processRoll(rollRoom, diceResults);

          if (!rollResult.valid) {
            broadcast(ws, { type: "error", message: rollResult.error });
            return;
          }

          if (rollResult.bust) {
            // Player busts, end turn
            const endResult = endTurn(rollRoom, data.playerId);

            broadcastToRoom(data.roomId, {
              type: "turn_bust",
              playerId: data.playerId,
              gameState: {
                tiles: rollRoom.game.tiles,
                playerStacks: rollRoom.game.playerStacks,
                currentPlayerId: rollRoom.game.currentPlayerId,
                turnState: rollRoom.game.turnState,
              },
              gameOver: endResult.gameOver,
            });

            if (endResult.gameOver) {
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
              playerId: data.playerId,
              diceResults,
              availableFaces: rollResult.availableFaces,
              faceCounts: rollResult.faceCounts,
              turnState: rollRoom.game.turnState,
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
            turnState: selectRoom.game.turnState,
          });
          break;

        case "end_turn":
          const endRoom = rooms.get(data.roomId);

          if (!endRoom || !endRoom.game) {
            broadcast(ws, { type: "error", message: "Game not found" });
            return;
          }

          if (endRoom.game.currentPlayerId !== data.playerId) {
            broadcast(ws, { type: "error", message: "Not your turn" });
            return;
          }

          const turnEndResult = endTurn(endRoom, data.playerId);

          broadcastToRoom(data.roomId, {
            type: "turn_ended",
            playerId: data.playerId,
            gameState: {
              tiles: endRoom.game.tiles,
              playerStacks: endRoom.game.playerStacks,
              currentPlayerId: endRoom.game.currentPlayerId,
              turnState: endRoom.game.turnState,
            },
            gameOver: turnEndResult.gameOver,
          });

          if (turnEndResult.gameOver) {
            const winner = calculateWinner(endRoom);
            const gameRecord = {
              roomName: endRoom.name,
              date: new Date().toISOString(),
              winner: {
                id: winner.winnerId,
                name: players.get(winner.winnerId)?.name,
                worms: winner.worms,
              },
              players: endRoom.players.map((pid) => ({
                id: pid,
                name: players.get(pid)?.name,
                worms: endRoom.game.playerStacks[pid].reduce(
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

            endRoom.status = "finished";
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
    // Clean up player
    for (const [playerId, player] of players.entries()) {
      if (player.ws === ws) {
        players.delete(playerId);

        // Remove from rooms
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
