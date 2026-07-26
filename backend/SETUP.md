# Auto Trading Server Setup Guide

## Quick Start

### 1. Install Python
Download from https://python.org (version 3.10+)
Check "Add to PATH" during installation.

### 2. Install Dependencies
```
cd backend
pip install -r requirements.txt
```

### 3. Configure API Keys
Edit `.env` file:
```
BINANCE_API_KEY=your_key_here
BINANCE_API_SECRET=your_secret_here
AUTO_TRADE_ENABLED=true
USE_TESTNET=true
```

### 4. Start Server
```
python app.py
```

### 5. Get Public URL (for TradingView)
```
ngrok http 5000
```
Copy the https URL (e.g., https://abc123.ngrok.io)

### 6. TradingView Alert Setup
1. Open TradingView chart
2. Create Alert on any indicator/strategy
3. In Alert settings:
   - Webhook URL: `https://your-ngrok-url/webhook`
   - Message:
```json
{
  "symbol": "{{ticker}}",
  "action": "buy",
  "price": "{{close}}",
  "time": "{{time}}",
  "exchange": "{{exchange}}",
  "interval": "{{interval}}",
  "amount": "10",
  "sl": "",
  "tp": "",
  "message": "RSI Oversold Signal"
}
```

## TradingView Alert Message Examples

### Simple Buy/Sell:
```json
{"symbol": "{{ticker}}", "action": "buy", "price": "{{close}}"}
```

### With Stop Loss & Take Profit:
```json
{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "price": "{{close}}",
  "amount": "20",
  "sl": "{{plot_3}}",
  "tp": "{{plot_4}}"
}
```

### Pine Script Strategy:
```json
{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "price": "{{strategy.order.price}}",
  "amount": "{{strategy.position_size}}"
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status |
| `/webhook` | POST | Receive TradingView alerts |
| `/alerts` | GET | Get all alerts |
| `/alerts` | DELETE | Clear alerts |
| `/trades` | GET | Get trade history |
| `/connect` | POST | Connect Binance API |
| `/balance` | GET | Get account balance |
| `/settings` | GET/POST | View/update settings |
| `/manual-trade` | POST | Execute manual trade |
| `/health` | GET | Health check |

## Safety Tips
- Start with USE_TESTNET=true (paper trading)
- Use small amounts first ($10-20)
- Disable withdrawals on Binance API
- Set IP restriction on API key
- Monitor bot regularly
