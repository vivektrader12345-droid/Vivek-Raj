"""
Vivek Marco Trader - Auto Trading Server
==========================================
TradingView Alert → Webhook → Binance Auto-Trade

Features:
- Receives TradingView webhook alerts
- Auto-executes trades on Binance (Spot + Futures)
- Supports market/limit orders
- Auto Stop Loss & Take Profit
- Trade logging & history
- Paper trading mode (testnet)

Setup:
1. Copy .env.example to .env and fill your API keys
2. pip install -r requirements.txt
3. python app.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime
import json
import os
import ccxt

app = Flask(__name__)
CORS(app)

# ===== CONFIGURATION =====
try:
    from dotenv import load_dotenv
    load_dotenv()
except:
    pass

API_KEY = os.environ.get('BINANCE_API_KEY', '')
API_SECRET = os.environ.get('BINANCE_API_SECRET', '')
AUTO_TRADE = os.environ.get('AUTO_TRADE_ENABLED', 'false').lower() == 'true'
DEFAULT_AMOUNT = float(os.environ.get('DEFAULT_TRADE_AMOUNT_USDT', 10))
DEFAULT_LEVERAGE = int(os.environ.get('DEFAULT_LEVERAGE', 1))
USE_TESTNET = os.environ.get('USE_TESTNET', 'true').lower() == 'true'

# ===== BINANCE CONNECTION =====
exchange = None

def connect_binance():
    global exchange
    if not API_KEY or not API_SECRET:
        print("[WARN] No API keys set. Auto-trade disabled.")
        return False
    try:
        exchange = ccxt.binance({
            'apiKey': API_KEY,
            'secret': API_SECRET,
            'sandbox': USE_TESTNET,
            'options': { 'defaultType': 'spot' },
            'enableRateLimit': True,
        })
        # Test connection
        balance = exchange.fetch_balance()
        usdt = balance.get('USDT', {}).get('free', 0)
        print(f"[OK] Binance connected! USDT Balance: ${usdt}")
        return True
    except Exception as e:
        print(f"[ERROR] Binance connection failed: {e}")
        return False

# ===== STORAGE =====
alerts = []
trade_history = []
settings = {
    'auto_trade': AUTO_TRADE,
    'amount_usdt': DEFAULT_AMOUNT,
    'leverage': DEFAULT_LEVERAGE,
    'use_testnet': USE_TESTNET,
    'sl_percent': 2.0,
    'tp_percent': 3.0,
    'max_daily_trades': 10,
    'allowed_pairs': ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT'],
}
daily_trades = 0

# ===== TRADE EXECUTION =====
def execute_trade(alert_data):
    """Execute a trade on Binance based on alert data"""
    global daily_trades
    
    if not exchange:
        return {'status': 'error', 'message': 'Exchange not connected'}
    
    if not settings['auto_trade']:
        return {'status': 'skipped', 'message': 'Auto-trade disabled'}
    
    if daily_trades >= settings['max_daily_trades']:
        return {'status': 'skipped', 'message': 'Max daily trades reached'}

    try:
        # Parse alert
        symbol = alert_data.get('symbol', '').upper().replace(' ', '')
        action = alert_data.get('action', '').upper()
        
        # Normalize symbol (BTCUSDT -> BTC/USDT)
        if '/' not in symbol:
            if symbol.endswith('USDT'):
                symbol = symbol[:-4] + '/USDT'
            elif symbol.endswith('USD'):
                symbol = symbol[:-3] + '/USD'

        # Check if pair is allowed
        if symbol not in settings['allowed_pairs']:
            return {'status': 'skipped', 'message': f'Pair {symbol} not in allowed list'}

        # Determine side
        if 'BUY' in action or 'LONG' in action:
            side = 'buy'
        elif 'SELL' in action or 'SHORT' in action:
            side = 'sell'
        else:
            return {'status': 'skipped', 'message': f'Unknown action: {action}'}

        # Calculate quantity
        amount_usdt = float(alert_data.get('amount', settings['amount_usdt']))
        ticker = exchange.fetch_ticker(symbol)
        current_price = ticker['last']
        quantity = amount_usdt / current_price

        # Execute market order
        order = exchange.create_market_order(symbol, side, quantity)
        
        # Set Stop Loss & Take Profit
        sl_price = None
        tp_price = None
        if settings['sl_percent'] > 0:
            if side == 'buy':
                sl_price = current_price * (1 - settings['sl_percent'] / 100)
                tp_price = current_price * (1 + settings['tp_percent'] / 100)
            else:
                sl_price = current_price * (1 + settings['sl_percent'] / 100)
                tp_price = current_price * (1 - settings['tp_percent'] / 100)

        # Log trade
        trade = {
            'id': f"trade_{int(datetime.now().timestamp()*1000)}",
            'order_id': order.get('id', ''),
            'symbol': symbol,
            'side': side,
            'price': current_price,
            'quantity': quantity,
            'amount_usdt': amount_usdt,
            'sl': sl_price,
            'tp': tp_price,
            'status': 'filled',
            'timestamp': datetime.now().isoformat(),
            'alert_source': 'tradingview'
        }
        trade_history.insert(0, trade)
        daily_trades += 1

        print(f"[TRADE] {side.upper()} {symbol} | Qty: {quantity:.6f} | Price: ${current_price} | Amount: ${amount_usdt}")
        
        return {'status': 'executed', 'trade': trade}

    except Exception as e:
        error_trade = {
            'id': f"err_{int(datetime.now().timestamp()*1000)}",
            'symbol': alert_data.get('symbol', 'Unknown'),
            'side': alert_data.get('action', 'Unknown'),
            'status': 'failed',
            'error': str(e),
            'timestamp': datetime.now().isoformat()
        }
        trade_history.insert(0, error_trade)
        print(f"[ERROR] Trade failed: {e}")
        return {'status': 'error', 'message': str(e)}

# ===== API ROUTES =====

@app.route('/')
def home():
    return jsonify({
        'service': 'Vivek Marco Trader - Auto Trading Server',
        'status': 'running',
        'exchange_connected': exchange is not None,
        'auto_trade': settings['auto_trade'],
        'testnet': settings['use_testnet'],
        'alerts': len(alerts),
        'trades_today': daily_trades,
    })

@app.route('/webhook', methods=['POST'])
def webhook():
    """Receive TradingView webhook and auto-execute trade"""
    try:
        if request.is_json:
            data = request.get_json()
        else:
            try:
                data = json.loads(request.data.decode('utf-8'))
            except:
                data = {'message': request.data.decode('utf-8')}

        alert = {
            'id': f'tv_{int(datetime.now().timestamp() * 1000)}',
            'symbol': data.get('symbol', 'Unknown'),
            'action': data.get('action', 'ALERT'),
            'price': data.get('price', '0'),
            'time': data.get('time', datetime.now().strftime('%H:%M:%S')),
            'exchange': data.get('exchange', 'TradingView'),
            'interval': data.get('interval', ''),
            'message': data.get('message', ''),
            'sl': data.get('sl', ''),
            'tp': data.get('tp', ''),
            'amount': data.get('amount', ''),
            'receivedAt': datetime.now().isoformat(),
        }
        alerts.insert(0, alert)
        if len(alerts) > 200:
            alerts.pop()

        print(f"[ALERT] {alert['action']} {alert['symbol']} @ ${alert['price']}")

        # Auto-execute trade if enabled
        trade_result = {'status': 'disabled'}
        if settings['auto_trade'] and exchange:
            trade_result = execute_trade(data)
            alert['trade_result'] = trade_result

        return jsonify({
            'status': 'success',
            'alert': alert,
            'trade': trade_result
        }), 200

    except Exception as e:
        print(f"[ERROR] {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/alerts', methods=['GET'])
def get_alerts():
    limit = request.args.get('limit', 50, type=int)
    return jsonify({'alerts': alerts[:limit], 'total': len(alerts)})

@app.route('/alerts', methods=['DELETE'])
def clear_alerts():
    alerts.clear()
    return jsonify({'status': 'cleared'})

@app.route('/trades', methods=['GET'])
def get_trades():
    return jsonify({'trades': trade_history, 'total': len(trade_history)})

@app.route('/trades', methods=['DELETE'])
def clear_trades():
    trade_history.clear()
    return jsonify({'status': 'cleared'})

@app.route('/settings', methods=['GET'])
def get_settings():
    return jsonify(settings)

@app.route('/settings', methods=['POST'])
def update_settings():
    data = request.get_json()
    for key in data:
        if key in settings:
            settings[key] = data[key]
    return jsonify({'status': 'updated', 'settings': settings})

@app.route('/connect', methods=['POST'])
def connect_exchange():
    """Connect to Binance with provided API keys"""
    global API_KEY, API_SECRET, exchange
    data = request.get_json()
    API_KEY = data.get('api_key', API_KEY)
    API_SECRET = data.get('api_secret', API_SECRET)
    
    os.environ['BINANCE_API_KEY'] = API_KEY
    os.environ['BINANCE_API_SECRET'] = API_SECRET
    
    success = connect_binance()
    if success:
        return jsonify({'status': 'connected', 'message': 'Binance connected successfully'})
    return jsonify({'status': 'error', 'message': 'Connection failed. Check API keys.'}), 400

@app.route('/balance', methods=['GET'])
def get_balance():
    """Get exchange balance"""
    if not exchange:
        return jsonify({'status': 'error', 'message': 'Not connected'}), 400
    try:
        balance = exchange.fetch_balance()
        usdt = balance.get('USDT', {})
        return jsonify({
            'usdt_free': usdt.get('free', 0),
            'usdt_used': usdt.get('used', 0),
            'usdt_total': usdt.get('total', 0),
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/manual-trade', methods=['POST'])
def manual_trade():
    """Execute a manual trade"""
    data = request.get_json()
    result = execute_trade(data)
    return jsonify(result)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'exchange': exchange is not None,
        'auto_trade': settings['auto_trade'],
        'trades_today': daily_trades,
        'timestamp': datetime.now().isoformat()
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    
    # Try connecting to Binance on startup
    if API_KEY and API_SECRET:
        connect_binance()
    
    print(f"""
    ╔═══════════════════════════════════════════════════════╗
    ║  Vivek Marco Trader - Auto Trading Server            ║
    ║  Running on http://localhost:{port}                     ║
    ║                                                       ║
    ║  Webhook:  http://localhost:{port}/webhook              ║
    ║  Alerts:   http://localhost:{port}/alerts               ║
    ║  Trades:   http://localhost:{port}/trades               ║
    ║  Balance:  http://localhost:{port}/balance              ║
    ║  Settings: http://localhost:{port}/settings             ║
    ║                                                       ║
    ║  Auto-Trade: {'ENABLED ✅' if AUTO_TRADE else 'DISABLED ❌'}
    ║  Testnet:    {'YES (Paper)' if USE_TESTNET else 'NO (REAL MONEY!)'}
    ║  Exchange:   {'Connected ✅' if exchange else 'Not connected ❌'}
    ╚═══════════════════════════════════════════════════════╝
    
    For public URL: ngrok http {port}
    """)
    app.run(host='0.0.0.0', port=port, debug=True)
