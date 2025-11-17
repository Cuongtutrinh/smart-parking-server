const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS configuration for production
const allowedOrigins = [
  'https://smart-parking-dashboard-delta.vercel.app',
  'https://smart-parking-dashboard.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001'
];

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// State management
let state = {
  total: 5,
  available: 5,
  slots: [0, 0, 0, 0, 0],
  logs: [],
  vehicles: [],
  revenue: 0,
  totalTransactions: 0
};

// API Routes
app.post('/update', (req, res) => {
  const data = req.body;
  console.log('POST /update =>', data);

  if (!data || !data.type) {
    return res.status(400).json({ ok: false, msg: 'bad payload' });
  }

  try {
    if (data.type === 'slot_change') {
      const idx = parseInt(data.id) - 1;
      if (idx >= 0 && idx < state.slots.length) {
        state.slots[idx] = data.result === 'OCCUPIED' ? 1 : 0;
        state.available = state.total - state.slots.reduce((a, b) => a + b, 0);
        
        state.logs.unshift({
          time: new Date().toISOString(),
          msg: `Slot ${idx + 1} -> ${data.result}`,
          type: 'slot'
        });
      }
    } 
    else if (data.type === 'vehicle_entry') {
      // Add vehicle to tracking
      const existingVehicle = state.vehicles.find(v => v.cardUID === data.id && v.status === 'parked');
      if (!existingVehicle) {
        state.vehicles.push({
          cardUID: data.id,
          entryTime: new Date().toISOString(),
          status: 'parked'
        });
      }
      
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🚗 VÀO: Xe ${data.id} đã vào bãi đỗ - ${data.result}`,
        type: 'entry'
      });
      
      state.available = data.available || state.available;
    } 
    else if (data.type === 'entry_time') {
      const timeInfo = data.result.replace('ENTRY_TIME_', '');
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `⏰ Xe ${data.id} vào lúc: ${timeInfo}`,
        type: 'time'
      });
    }
    else if (data.type === 'vehicle_exiting') {
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🚗 RA: Xe ${data.id} đang rời khỏi bãi đỗ`,
        type: 'exiting'
      });
    }
    else if (data.type === 'exit_time') {
      const timeInfo = data.result.replace('EXIT_TIME_', '');
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `⏰ Xe ${data.id} ra lúc: ${timeInfo}`,
        type: 'time'
      });
    }
    else if (data.type === 'payment_info') {
      // Remove vehicle and calculate revenue
      const vehicleIndex = state.vehicles.findIndex(v => v.cardUID === data.id && v.status === 'parked');
      if (vehicleIndex !== -1) {
        state.vehicles[vehicleIndex].status = 'exited';
        state.vehicles[vehicleIndex].exitTime = new Date().toISOString();
        
        // Extract fee from result
        const feeMatch = data.result.match(/FEE_(\d+)_TIME_(.+)/);
        if (feeMatch) {
          const fee = parseInt(feeMatch[1]);
          const parkTime = feeMatch[2];
          state.revenue += fee;
          state.totalTransactions++;
          
          state.logs.unshift({
            time: new Date().toISOString(),
            msg: `💰 THANH TOÁN: Xe ${data.id} - ${parkTime} - Phí: ${fee}K VND`,
            type: 'payment'
          });
        }
      }
      
      state.available = data.available || state.available;
    }
    else if (data.type === 'slot_occupied') {
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🅿️ Slot ${data.id} đã có xe đỗ`,
        type: 'slot'
      });
    }
    else if (data.type === 'slot_freed') {
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🅿️ Slot ${data.id} đã trống`,
        type: 'slot'
      });
    }
    else if (data.type === 'slots_update') {
      state.available = parseInt(data.result.replace('AVAILABLE_', '')) || state.available;
    }

    // Keep logs reasonable
    if (state.logs.length > 200) state.logs = state.logs.slice(0, 100);

    // Broadcast to all connected clients
    io.emit('update', state);
    
    return res.json({ ok: true, state: state });
  } catch (error) {
    console.error('Error processing update:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Get current state
app.get('/state', (req, res) => {
  res.json(state);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    vehicles: state.vehicles.length,
    available: state.available
  });
});

// Reset system (for testing)
app.post('/reset', (req, res) => {
  state = {
    total: 5,
    available: 5,
    slots: [0, 0, 0, 0, 0],
    logs: [],
    vehicles: [],
    revenue: 0,
    totalTransactions: 0
  };
  
  io.emit('update', state);
  res.json({ ok: true, msg: 'System reset' });
});

// Socket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current state to newly connected client
  socket.emit('update', state);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚗 Smart Parking Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 API endpoint: http://localhost:${PORT}/update`);
});
