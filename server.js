const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'https://smart-parking-dashboard-delta.vercel.app',
  'https://smart-parking-dashboard.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:8080'
];

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('render.com') || origin.includes('vercel.app')) {
        return callback(null, true);
      } else {
        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('render.com') || origin.includes('vercel.app')) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// State management
let state = {
  total: 5,
  available: 5,
  slots: [0, 0, 0, 0, 0],
  logs: [],
  vehicles: [],
  revenue: 0,
  totalTransactions: 0,
  systemConfig: {
    rfidType: "Single Reader (Entry/Exit)",
    pricing: "500 VND/minute",
    slots: 5
  }
};

// API Routes
app.post('/update', (req, res) => {
  const data = req.body;
  console.log('POST /update =>', data);

  if (!data || !data.type) {
    return res.status(400).json({ ok: false, msg: 'bad payload' });
  }

  try {
    // 🆕 XỬ LÝ vehicle_entry VÀ vehicle_reentry TRƯỚC
    if (data.type === 'vehicle_entry') {
      const existingVehicle = state.vehicles.find(v => v.cardUID === data.id && v.status === 'parked');
      if (!existingVehicle) {
        state.vehicles.push({
          cardUID: data.id,
          entryTime: new Date().toISOString(),
          status: 'parked',
          slotNumber: 0,
          parkStartTime: new Date().toISOString(),
          currentFee: 0
        });
        
        console.log('✅ Vehicle added to tracking:', data.id);
      }
      
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🚗 VÀO: Xe ${data.id} đã vào bãi đỗ`,
        type: 'entry'
      });
      
      state.available = data.available || state.available;
    }
    else if (data.type === 'vehicle_reentry') {
      // Tìm xe và cập nhật lại trạng thái
      const vehicleIndex = state.vehicles.findIndex(v => v.cardUID === data.id);
      if (vehicleIndex !== -1) {
        state.vehicles[vehicleIndex].status = 'parked';
        state.vehicles[vehicleIndex].entryTime = new Date().toISOString();
        state.vehicles[vehicleIndex].parkStartTime = new Date().toISOString();
        state.vehicles[vehicleIndex].slotNumber = 0;
        
        console.log('✅ Vehicle re-entry updated:', data.id);
      } else {
        // Nếu không tìm thấy, tạo mới
        state.vehicles.push({
          cardUID: data.id,
          entryTime: new Date().toISOString(),
          status: 'parked',
          slotNumber: 0,
          parkStartTime: new Date().toISOString(),
          currentFee: 0
        });
      }
      
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `🔁 VÀO LẠI: Xe ${data.id} đã vào lại bãi đỗ`,
        type: 'entry'
      });
      
      state.available = data.available || state.available;
    }
    else if (data.type === 'entry_time') {
      const timeInfo = data.result.replace(/ENTRY_TIME_|REENTRY_TIME_/, '');
      state.logs.unshift({
        time: new Date().toISOString(),
        msg: `⏰ Xe ${data.id} vào lúc: ${timeInfo}`,
        type: 'time'
      });
    }
    // 🆕 XỬ LÝ vehicle_parked - PHẢI CÓ XE TRONG DANH SÁCH
    else if (data.type === 'vehicle_parked') {
      const vehicleIndex = state.vehicles.findIndex(v => v.cardUID === data.id && v.status === 'parked');
      
      if (vehicleIndex !== -1) {
        const slotInfo = data.result.replace('PARKED_SLOT_', '');
        state.vehicles[vehicleIndex].slotNumber = parseInt(slotInfo);
        
        console.log('✅ Vehicle parked in slot:', data.id, '-> Slot', slotInfo);
        
        state.logs.unshift({
          time: new Date().toISOString(),
          msg: `🅿️ Xe ${data.id} đã đỗ vào slot ${slotInfo}`,
          type: 'parking'
        });
      } else {
        console.warn('⚠️ Vehicle not found for parking:', data.id);
      }
    }
    else if (data.type === 'slot_occupied') {
      const idx = parseInt(data.id) - 1;
      if (idx >= 0 && idx < state.slots.length) {
        state.slots[idx] = 1;
        state.available = state.total - state.slots.reduce((a, b) => a + b, 0);
        
        state.logs.unshift({
          time: new Date().toISOString(),
          msg: `🅿️ Slot ${data.id} đã có xe đỗ`,
          type: 'slot'
        });
      }
    } 
    else if (data.type === 'slot_freed') {
      const idx = parseInt(data.id) - 1;
      if (idx >= 0 && idx < state.slots.length) {
        state.slots[idx] = 0;
        state.available = state.total - state.slots.reduce((a, b) => a + b, 0);
        
        state.logs.unshift({
          time: new Date().toISOString(),
          msg: `🅿️ Slot ${data.id} đã trống`,
          type: 'slot'
        });
      }
    }
    else if (data.type === 'vehicle_left_slot') {
      const vehicleIndex = state.vehicles.findIndex(v => v.cardUID === data.id && v.status === 'parked');
      if (vehicleIndex !== -1) {
        const slotInfo = data.result.replace('LEFT_SLOT_', '');
        state.vehicles[vehicleIndex].slotNumber = 0;
        
        state.logs.unshift({
          time: new Date().toISOString(),
          msg: `🚗 Xe ${data.id} đã rời slot ${slotInfo}`,
          type: 'movement'
        });
      }
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
      const vehicleIndex = state.vehicles.findIndex(v => v.cardUID === data.id && v.status === 'parked');
      if (vehicleIndex !== -1) {
        state.vehicles[vehicleIndex].status = 'exited';
        state.vehicles[vehicleIndex].exitTime = new Date().toISOString();
        
        const feeMatch = data.result.match(/FEE_(\d+)_TIME_(\d+)m/);
        if (feeMatch) {
          const fee = parseInt(feeMatch[1]) * 100;
          const parkTime = feeMatch[2];
          state.revenue += fee;
          state.totalTransactions++;
          
          state.logs.unshift({
            time: new Date().toISOString(),
            msg: `💰 THANH TOÁN: Xe ${data.id} - ${parkTime} phút - Phí: ${fee} VND`,
            type: 'payment'
          });
        }
      }
      
      state.available = data.available || state.available;
    }
    else if (data.type === 'slots_update') {
      state.available = parseInt(data.result.replace('AVAILABLE_', '')) || state.available;
    }

    if (state.logs.length > 200) state.logs = state.logs.slice(0, 100);

    io.emit('update', state);
    
    return res.json({ ok: true, state: state });
  } catch (error) {
    console.error('Error processing update:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/state', (req, res) => {
  res.json(state);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    vehicles: state.vehicles.length,
    available: state.available,
    server: 'smart-parking-api-asm5.onrender.com',
    system: '1 RFID System'
  });
});

app.get('/test-socket', (req, res) => {
  res.json({ 
    message: 'Socket.IO server is running',
    connectedClients: io.engine.clientsCount,
    system: '1 RFID Parking System'
  });
});

app.post('/reset', (req, res) => {
  state = {
    total: 5,
    available: 5,
    slots: [0, 0, 0, 0, 0],
    logs: [],
    vehicles: [],
    revenue: 0,
    totalTransactions: 0,
    systemConfig: {
      rfidType: "Single Reader (Entry/Exit)",
      pricing: "500 VND/minute",
      slots: 5
    }
  };
  
  io.emit('update', state);
  res.json({ ok: true, msg: 'System reset' });
});

io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
  
  socket.emit('update', state);
  
  socket.on('disconnect', (reason) => {
    console.log('❌ Client disconnected:', socket.id, reason);
  });

  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚗 Smart Parking Server (1 RFID) running on port ${PORT}`);
  console.log(`📍 Health check: https://smart-parking-api-asm5.onrender.com/health`);
  console.log(`📍 API endpoint: https://smart-parking-api-asm5.onrender.com/update`);
  console.log(`📍 Dashboard: https://smart-parking-dashboard-delta.vercel.app`);
  console.log(`💰 Pricing: 500 VND/minute`);
});
