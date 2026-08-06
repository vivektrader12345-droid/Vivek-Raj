"""
Vivek Marco Trader - Auto Trading Server
==========================================
TradingView Alert → Webhook → Demo/Live Trading

Features:
- Per-user webhook keys (each user gets unique webhook URL)
- Demo trading mode (virtual trades, no real money)
- Live trading mode (real exchange orders via Binance/Delta)
- Firebase Firestore for per-user trade storage
- Real-time portfolio sync
- Auto Stop Loss & Take Profit

Setup:
1. Copy .env.example to .env and fill API keys
2. pip install -r requirements.txt
3. python app.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime
from functools import wraps
import json
import os
import uuid
import ccxt
from firebase_admin import auth as firebase_auth
from firebase_admin_setup import initialize_firebase_services
from auth_policy import has_current_otp_proof
from binance_sync import start_sync_for_user, stop_sync_for_user, get_sync_status, BinanceSyncService

app = Flask(__name__)
CORS(app)

# ===== CONFIGURATION =====
try:
    from dotenv import load_dotenv
    load_dotenv()
except:
    pass

# Exchange config
BINANCE_API_KEY = os.environ.get('BINANCE_API_KEY', '')
BINANCE_API_SECRET = os.environ.get('BINANCE_API_SECRET', '')
USE_TESTNET = os.environ.get('USE_TESTNET', 'false').lower() == 'true'
CONNECT_EXCHANGE_ON_STARTUP = os.environ.get('CONNECT_EXCHANGE_ON_STARTUP', 'false').lower() == 'true'

# Firebase Admin uses Application Default Credentials. In hosted environments,
# GOOGLE_APPLICATION_CREDENTIALS may reference a securely mounted secret file.
FIREBASE_PROJECT_ID = os.environ.get('FIREBASE_PROJECT_ID', 'vivek-crypto-trader-b8d19')
firebase_services = initialize_firebase_services(FIREBASE_PROJECT_ID)
firebase_app = firebase_services.app
db = firebase_services.db

if firebase_services.auth_ready and db is not None:
    print("[OK] Firebase authentication and Firestore connected")
elif firebase_services.auth_ready:
    print("[WARN] Firebase authentication connected; Firestore storage unavailable")
else:
    print("[WARN] Firebase authentication unavailable; protected APIs fail closed")

# Legacy webhook live execution is disabled by default. The v1 intelligence
# system is the supported ingestion path and remains fail-closed for live orders.
LEGACY_WEBHOOK_LIVE_ENABLED = os.environ.get('LEGACY_WEBHOOK_LIVE_ENABLED', 'false').lower() == 'true'


def require_firebase_user(handler):
    """Protect legacy per-user webhook management routes during migration."""
    @wraps(handler)
    def wrapped(*args, **kwargs):
        header = request.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return jsonify({'status': 'error', 'message': 'Authentication required'}), 401
        if firebase_app is None:
            return jsonify({'status': 'error', 'message': 'Authentication service unavailable'}), 503
        try:
            decoded = firebase_auth.verify_id_token(
                header[7:].strip(),
                app=firebase_app,
                check_revoked=True,
            )
            uid = decoded.get('uid') or decoded.get('sub')
            if not uid:
                return jsonify({'status': 'error', 'message': 'Invalid token'}), 401
            if not has_current_otp_proof(decoded):
                return jsonify({'status': 'error', 'message': 'OTP verification required'}), 403
        except Exception:
            return jsonify({'status': 'error', 'message': 'Invalid or expired token'}), 401
        requested_uid = kwargs.get('user_id')
        if not requested_uid and request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            body = request.get_json(silent=True) or {}
            if isinstance(body, dict):
                requested_uid = body.get('userId') or body.get('user_id')
        if requested_uid and str(requested_uid) != str(uid):
            return jsonify({'status': 'error', 'message': 'Forbidden'}), 403
        return handler(*args, **kwargs)
    return wrapped

# Secure OTP endpoints keep codes and verification state server-side.
from otp_auth import create_otp_blueprint

if 'otp_auth' not in app.blueprints:
    app.register_blueprint(create_otp_blueprint(db, firebase_app=firebase_app))

# Secure TradingView webhook intelligence APIs.
from webhook_intelligence import create_webhook_blueprint

if not app.config.get('MAX_CONTENT_LENGTH'):
    app.config['MAX_CONTENT_LENGTH'] = 256 * 1024
if 'webhook_intelligence' not in app.blueprints:
    app.register_blueprint(create_webhook_blueprint(
        db,
        base_url=os.environ.get('WEBHOOK_BASE_URL'),
        firebase_app=firebase_app,
    ))

# ===== IN-MEMORY STORAGE (fallback when Firebase not available) =====
memory_alerts = []
memory_trades = []
memory_portfolio = {
    'balance': 100000,
    'availableMargin': 100000,
    'usedMargin': 0,
    'openPositions': 0,
    'totalTrades': 0,
    'totalPnl': 0,
    'realizedPnl': 0,
    'unrealizedPnl': 0,
    'winRate': 0,
    'wins': 0,
    'losses': 0,
    'mode': 'demo',
}

# ===== EXCHANGE CONNECTION =====
exchange = None

def connect_exchange(api_key=None, api_secret=None, testnet=False):
    """Connect to Binance exchange"""
    global exchange
    key = api_key or BINANCE_API_KEY
    secret = api_secret or BINANCE_API_SECRET
    if not key or not secret:
        return False
    try:
        exchange = ccxt.binance({
            'apiKey': key,
            'secret': secret,
            'sandbox': testnet,
            'options': {'defaultType': 'future'},
            'enableRateLimit': True,
        })
        exchange.fetch_balance()
        print(f"[OK] Exchange connected (testnet={testnet})")
        return True
    except Exception as e:
        print(f"[ERROR] Exchange connection failed: {e}")
        exchange = None
        return False

# Exchange startup is explicit opt-in to prevent credential-bearing .env files
# from causing network activity during backend startup.
if CONNECT_EXCHANGE_ON_STARTUP and BINANCE_API_KEY and BINANCE_API_SECRET:
    connect_exchange(testnet=USE_TESTNET)


# ===== DEMO TRADING ENGINE =====

def execute_demo_trade(user_id, trade_data):
    """Execute a virtual trade (demo mode) and save to Firebase"""
    try:
        symbol = trade_data.get('symbol', 'BTC/USDT').upper()
        if '/' not in symbol:
            if symbol.endswith('USDT'):
                symbol = symbol[:-4] + '/USDT'

        side = trade_data.get('action', 'buy').lower()
        if 'buy' in side or 'long' in side:
            side = 'buy'
        elif 'sell' in side or 'short' in side:
            side = 'sell'
        else:
            return {'status': 'error', 'message': f'Unknown action: {side}'}

        price = float(trade_data.get('price', 0))
        qty = float(trade_data.get('qty', trade_data.get('quantity', trade_data.get('amount', 1))))
        leverage = int(trade_data.get('leverage', 10))
        sl = float(trade_data.get('sl', trade_data.get('stop_loss', 0))) if trade_data.get('sl') or trade_data.get('stop_loss') else None
        tp = float(trade_data.get('tp', trade_data.get('take_profit', 0))) if trade_data.get('tp') or trade_data.get('take_profit') else None

        if price <= 0:
            return {'status': 'error', 'message': 'Invalid price'}

        # Calculate margin
        position_value = price * qty
        margin = position_value / leverage
        fee = position_value * 0.0004  # 0.04% taker fee

        # Create trade record
        trade = {
            'id': f'wh_{int(datetime.now().timestamp() * 1000)}',
            'symbol': symbol,
            'side': side,
            'entryPrice': price,
            'quantity': qty,
            'leverage': leverage,
            'margin': round(margin, 2),
            'fee': round(fee, 4),
            'positionValue': round(position_value, 2),
            'stopLoss': sl,
            'takeProfit': tp,
            'status': 'open',
            'mode': 'demo',
            'source': 'tradingview_webhook',
            'pnl': 0,
            'roi': 0,
            'openedAt': datetime.now().isoformat(),
            'closedAt': None,
            'exitPrice': None,
        }

        # Save to Firebase
        if db:
            doc_ref = db.collection('users').document(user_id).collection('webhook_trades').document(trade['id'])
            doc_ref.set(trade)

            # Update portfolio
            portfolio_ref = db.collection('users').document(user_id).collection('data').document('portfolio')
            portfolio = portfolio_ref.get()
            if portfolio.exists:
                p = portfolio.to_dict()
                portfolio_ref.update({
                    'usedMargin': round(p.get('usedMargin', 0) + margin, 2),
                    'availableMargin': round(p.get('availableMargin', 100000) - margin, 2),
                    'openPositions': p.get('openPositions', 0) + 1,
                    'totalTrades': p.get('totalTrades', 0) + 1,
                    'lastUpdated': datetime.now().isoformat(),
                })
            else:
                portfolio_ref.set({
                    'balance': 100000,
                    'availableMargin': 100000 - margin,
                    'usedMargin': margin,
                    'openPositions': 1,
                    'totalTrades': 1,
                    'totalPnl': 0,
                    'realizedPnl': 0,
                    'unrealizedPnl': 0,
                    'winRate': 0,
                    'wins': 0,
                    'losses': 0,
                    'mode': 'demo',
                    'lastUpdated': datetime.now().isoformat(),
                })

        print(f"[DEMO] {side.upper()} {symbol} | Qty: {qty} | Price: ${price} | Leverage: {leverage}x | Margin: ${margin:.2f}")
        return {'status': 'executed', 'mode': 'demo', 'trade': trade}

    except Exception as e:
        print(f"[ERROR] Demo trade failed: {e}")
        return {'status': 'error', 'message': str(e)}


# ===== LIVE TRADING ENGINE =====

def execute_live_trade(user_id, trade_data):
    """Execute a real trade on Binance and save to Firebase"""
    if not exchange:
        return {'status': 'error', 'message': 'Exchange not connected'}

    try:
        symbol = trade_data.get('symbol', 'BTC/USDT').upper()
        if '/' not in symbol:
            if symbol.endswith('USDT'):
                symbol = symbol[:-4] + '/USDT'

        side = trade_data.get('action', 'buy').lower()
        if 'buy' in side or 'long' in side:
            side = 'buy'
        elif 'sell' in side or 'short' in side:
            side = 'sell'
        else:
            return {'status': 'error', 'message': f'Unknown action: {side}'}

        qty = float(trade_data.get('qty', trade_data.get('quantity', trade_data.get('amount', 0))))
        leverage = int(trade_data.get('leverage', 10))
        sl = trade_data.get('sl') or trade_data.get('stop_loss')
        tp = trade_data.get('tp') or trade_data.get('take_profit')

        # Set leverage
        try:
            exchange.set_leverage(leverage, symbol.replace('/', ''))
        except:
            pass

        # Execute market order
        order = exchange.create_market_order(symbol, side, qty)
        fill_price = float(order.get('average', order.get('price', 0)))
        filled_qty = float(order.get('filled', qty))

        # Position value
        position_value = fill_price * filled_qty
        margin = position_value / leverage
        fee = position_value * 0.0004

        # Set SL/TP orders
        sl_order_id = None
        tp_order_id = None
        if sl:
            try:
                sl_side = 'sell' if side == 'buy' else 'buy'
                sl_order = exchange.create_order(symbol, 'stop_market', sl_side, filled_qty, None, {'stopPrice': float(sl)})
                sl_order_id = sl_order.get('id')
            except Exception as e:
                print(f"[WARN] SL order failed: {e}")

        if tp:
            try:
                tp_side = 'sell' if side == 'buy' else 'buy'
                tp_order = exchange.create_order(symbol, 'take_profit_market', tp_side, filled_qty, None, {'stopPrice': float(tp)})
                tp_order_id = tp_order.get('id')
            except Exception as e:
                print(f"[WARN] TP order failed: {e}")

        # Create trade record
        trade = {
            'id': f'live_{order.get("id", int(datetime.now().timestamp() * 1000))}',
            'orderId': order.get('id', ''),
            'slOrderId': sl_order_id,
            'tpOrderId': tp_order_id,
            'symbol': symbol,
            'side': side,
            'entryPrice': fill_price,
            'quantity': filled_qty,
            'leverage': leverage,
            'margin': round(margin, 2),
            'fee': round(fee, 4),
            'positionValue': round(position_value, 2),
            'stopLoss': float(sl) if sl else None,
            'takeProfit': float(tp) if tp else None,
            'status': 'open',
            'mode': 'live',
            'source': 'tradingview_webhook',
            'pnl': 0,
            'roi': 0,
            'openedAt': datetime.now().isoformat(),
            'closedAt': None,
            'exitPrice': None,
            'orderStatus': order.get('status', 'filled'),
            'filledQty': filled_qty,
        }

        # Save to Firebase
        if db:
            db.collection('users').document(user_id).collection('webhook_trades').document(trade['id']).set(trade)

        print(f"[LIVE] {side.upper()} {symbol} | Qty: {filled_qty} | Price: ${fill_price} | Leverage: {leverage}x")
        return {'status': 'executed', 'mode': 'live', 'trade': trade}

    except Exception as e:
        print(f"[ERROR] Live trade failed: {e}")
        return {'status': 'error', 'message': str(e)}


# ===== API ROUTES =====

@app.route('/')
def home():
    return jsonify({
        'service': 'Vivek Marco Trader - Auto Trading Server',
        'status': 'running',
        'exchange_connected': exchange is not None,
        'firebase_connected': db is not None,
        'testnet': USE_TESTNET,
        'version': '2.0',
    })


@app.route('/webhook/<webhook_key>', methods=['POST'])
def webhook_with_key(webhook_key):
    """
    Per-user webhook endpoint.
    URL format: https://vivek-raj.onrender.com/webhook/<user_webhook_key>
    TradingView sends alerts here.
    """
    try:
        # Find user by webhook key
        user_id = None
        user_mode = 'demo'

        if db:
            # Look up which user owns this webhook key
            users_ref = db.collection('users')
            query = users_ref.where('webhookKey', '==', webhook_key).limit(1).get()
            for doc in query:
                user_id = doc.id
                user_data = doc.to_dict()
                user_mode = user_data.get('tradingMode', 'demo')
                break

        if not user_id:
            return jsonify({'status': 'error', 'message': 'Invalid webhook key'}), 401

        # Parse alert data
        if request.is_json:
            data = request.get_json()
        else:
            try:
                data = json.loads(request.data.decode('utf-8'))
            except:
                data = {'message': request.data.decode('utf-8')}

        # Log alert
        alert = {
            'id': f'alert_{int(datetime.now().timestamp() * 1000)}',
            'userId': user_id,
            'data': data,
            'receivedAt': datetime.now().isoformat(),
            'mode': user_mode,
        }

        if db:
            db.collection('users').document(user_id).collection('webhook_alerts').add(alert)

        print(f"[WEBHOOK] User: {user_id} | Mode: {user_mode} | Action: {data.get('action', 'unknown')}")

        # Execute trade based on mode
        if user_mode == 'live' and LEGACY_WEBHOOK_LIVE_ENABLED:
            result = execute_live_trade(user_id, data)
        else:
            result = execute_demo_trade(user_id, data)

        return jsonify({'status': 'success', 'alert': alert, 'trade': result}), 200

    except Exception as e:
        print(f"[ERROR] Webhook: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/webhook', methods=['POST'])
def webhook_legacy():
    """Legacy webhook — always works, stores in memory + Firebase if available"""
    try:
        if request.is_json:
            data = request.get_json()
        else:
            try:
                data = json.loads(request.data.decode('utf-8'))
            except:
                data = {'message': request.data.decode('utf-8')}

        # Create alert record
        alert = {
            'id': f'alert_{int(datetime.now().timestamp() * 1000)}',
            'action': data.get('action', 'ALERT'),
            'symbol': data.get('symbol', 'Unknown'),
            'price': data.get('price', 0),
            'qty': data.get('qty', data.get('quantity', data.get('amount', 1))),
            'leverage': data.get('leverage', 10),
            'sl': data.get('sl', None),
            'tp': data.get('tp', None),
            'data': data,
            'receivedAt': datetime.now().isoformat(),
        }

        # Store in memory (always works)
        memory_alerts.insert(0, alert)
        if len(memory_alerts) > 200:
            memory_alerts.pop()

        print(f"[WEBHOOK] Received: {alert['action']} {alert['symbol']} @ ${alert['price']}")

        # Try to find user by webhook key in the data
        webhook_key = data.get('key', data.get('webhook_key', data.get('secret', '')))
        user_id = None
        user_mode = 'demo'

        if webhook_key and db:
            try:
                users_ref = db.collection('users')
                query_result = users_ref.where('webhookKey', '==', webhook_key).limit(1).get()
                for doc_snap in query_result:
                    user_id = doc_snap.id
                    user_data = doc_snap.to_dict()
                    user_mode = user_data.get('tradingMode', 'demo')
                    break
            except:
                pass

        # Execute trade
        trade_result = None
        if user_id:
            if user_mode == 'live' and LEGACY_WEBHOOK_LIVE_ENABLED:
                trade_result = execute_live_trade(user_id, data)
            else:
                trade_result = execute_demo_trade(user_id, data)
        else:
            # No user — store as demo trade in memory
            trade = {
                'id': alert['id'],
                'symbol': alert['symbol'],
                'side': 'buy' if 'buy' in str(alert['action']).lower() else 'sell',
                'entryPrice': float(alert['price']) if alert['price'] else 0,
                'quantity': float(alert['qty']),
                'leverage': int(alert['leverage']),
                'stopLoss': alert['sl'],
                'takeProfit': alert['tp'],
                'status': 'open',
                'mode': 'demo',
                'source': 'tradingview',
                'openedAt': datetime.now().isoformat(),
            }
            memory_trades.insert(0, trade)
            trade_result = {'status': 'executed', 'mode': 'demo (memory)', 'trade': trade}

        return jsonify({
            'status': 'success',
            'alert': alert,
            'trade': trade_result,
        }), 200

    except Exception as e:
        print(f"[ERROR] Webhook: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/portfolio/<user_id>', methods=['GET'])
@require_firebase_user
def get_portfolio(user_id):
    """Get user's portfolio data"""
    if not db:
        return jsonify({'status': 'error', 'message': 'Database not connected'}), 500

    portfolio_ref = db.collection('users').document(user_id).collection('data').document('portfolio')
    portfolio = portfolio_ref.get()

    if portfolio.exists:
        return jsonify(portfolio.to_dict())
    else:
        # Return default portfolio
        default = {
            'balance': 100000,
            'availableMargin': 100000,
            'usedMargin': 0,
            'openPositions': 0,
            'totalTrades': 0,
            'totalPnl': 0,
            'realizedPnl': 0,
            'unrealizedPnl': 0,
            'winRate': 0,
            'wins': 0,
            'losses': 0,
            'mode': 'demo',
        }
        portfolio_ref.set(default)
        return jsonify(default)


@app.route('/api/trades/<user_id>', methods=['GET'])
@require_firebase_user
def get_user_trades(user_id):
    """Get user's webhook trades"""
    if not db:
        return jsonify({'trades': []}), 200

    trades_ref = db.collection('users').document(user_id).collection('webhook_trades')
    trades = trades_ref.order_by('openedAt', direction=firestore.Query.DESCENDING).limit(100).get()
    trade_list = [t.to_dict() for t in trades]
    return jsonify({'trades': trade_list, 'total': len(trade_list)})


@app.route('/api/trades/<user_id>/<trade_id>/close', methods=['POST'])
@require_firebase_user
def close_trade(user_id, trade_id):
    """Close a trade manually"""
    if not db:
        return jsonify({'status': 'error'}), 500

    data = request.get_json() or {}
    exit_price = float(data.get('exitPrice', data.get('price', 0)))

    trade_ref = db.collection('users').document(user_id).collection('webhook_trades').document(trade_id)
    trade_doc = trade_ref.get()

    if not trade_doc.exists:
        return jsonify({'status': 'error', 'message': 'Trade not found'}), 404

    trade = trade_doc.to_dict()
    if trade['status'] != 'open':
        return jsonify({'status': 'error', 'message': 'Trade already closed'}), 400

    # Calculate PnL
    entry = trade['entryPrice']
    qty = trade['quantity']
    leverage = trade['leverage']

    if trade['side'] == 'buy':
        pnl = (exit_price - entry) * qty
    else:
        pnl = (entry - exit_price) * qty

    roi = (pnl / trade['margin']) * 100 if trade['margin'] > 0 else 0

    # Update trade
    trade_ref.update({
        'status': 'closed',
        'exitPrice': exit_price,
        'pnl': round(pnl, 2),
        'roi': round(roi, 2),
        'closedAt': datetime.now().isoformat(),
    })

    # Update portfolio
    portfolio_ref = db.collection('users').document(user_id).collection('data').document('portfolio')
    portfolio = portfolio_ref.get()
    if portfolio.exists:
        p = portfolio.to_dict()
        is_win = pnl > 0
        portfolio_ref.update({
            'usedMargin': round(max(0, p.get('usedMargin', 0) - trade['margin']), 2),
            'availableMargin': round(p.get('availableMargin', 100000) + trade['margin'] + pnl, 2),
            'balance': round(p.get('balance', 100000) + pnl, 2),
            'openPositions': max(0, p.get('openPositions', 0) - 1),
            'realizedPnl': round(p.get('realizedPnl', 0) + pnl, 2),
            'totalPnl': round(p.get('totalPnl', 0) + pnl, 2),
            'wins': p.get('wins', 0) + (1 if is_win else 0),
            'losses': p.get('losses', 0) + (0 if is_win else 1),
            'winRate': round(((p.get('wins', 0) + (1 if is_win else 0)) / max(1, p.get('totalTrades', 1))) * 100, 1),
            'lastUpdated': datetime.now().isoformat(),
        })

    return jsonify({'status': 'closed', 'pnl': round(pnl, 2), 'roi': round(roi, 2)})


@app.route('/api/generate-webhook-key/<user_id>', methods=['POST'])
@require_firebase_user
def generate_webhook_key(user_id):
    """Generate a unique webhook key for a user"""
    if not db:
        return jsonify({'status': 'error'}), 500

    webhook_key = str(uuid.uuid4()).replace('-', '')[:16]

    # Save to user document
    db.collection('users').document(user_id).update({
        'webhookKey': webhook_key,
        'webhookUrl': f'https://vivek-raj.onrender.com/webhook/{webhook_key}',
    })

    return jsonify({
        'status': 'success',
        'webhookKey': webhook_key,
        'webhookUrl': f'https://vivek-raj.onrender.com/webhook/{webhook_key}',
    })


@app.route('/api/set-mode/<user_id>', methods=['POST'])
@require_firebase_user
def set_trading_mode(user_id):
    """Set user's trading mode (demo/live)"""
    if not db:
        return jsonify({'status': 'error'}), 500

    data = request.get_json()
    mode = data.get('mode', 'demo')

    if mode not in ['demo', 'live']:
        return jsonify({'status': 'error', 'message': 'Mode must be demo or live'}), 400

    db.collection('users').document(user_id).update({'tradingMode': mode})

    # Update portfolio mode
    db.collection('users').document(user_id).collection('data').document('portfolio').set(
        {'mode': mode}, merge=True
    )

    return jsonify({'status': 'success', 'mode': mode})


@app.route('/api/connect-exchange/<user_id>', methods=['POST'])
@require_firebase_user
def connect_user_exchange(user_id):
    """Connect exchange API keys for a user"""
    data = request.get_json()
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', False)

    success = connect_exchange(api_key, api_secret, testnet)

    if success and db:
        # Save exchange connection status (NOT the keys for security)
        db.collection('users').document(user_id).update({
            'exchangeConnected': True,
            'exchangeTestnet': testnet,
        })

    return jsonify({
        'status': 'connected' if success else 'failed',
        'exchange_connected': success,
    })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'exchange': exchange is not None,
        'firebase': db is not None,
        'alerts_count': len(memory_alerts),
        'trades_count': len(memory_trades),
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/alerts', methods=['GET'])
def get_alerts():
    """Get recent alerts from memory"""
    limit = request.args.get('limit', 50, type=int)
    return jsonify({'alerts': memory_alerts[:limit], 'total': len(memory_alerts)})


@app.route('/trades', methods=['GET'])
def get_memory_trades():
    """Get trades from memory"""
    return jsonify({'trades': memory_trades, 'total': len(memory_trades)})


# ==================== BINANCE SYNC ENDPOINTS ====================

@app.route('/api/binance/connect', methods=['POST'])
@require_firebase_user
def binance_connect():
    """Verify and connect Binance Futures Testnet API"""
    data = request.get_json()
    user_id = data.get('userId')
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', True)

    if not user_id or not api_key or not api_secret:
        return jsonify({'status': 'error', 'message': 'Missing userId, apiKey, or apiSecret'}), 400

    # Verify connection
    service = BinanceSyncService(user_id, api_key, api_secret, db, testnet)
    result = service.verify_connection()

    if result['status'] == 'connected':
        # Save connection status to Firebase (NOT the keys — security)
        if db:
            db.collection('users').document(user_id).update({
                'binanceConnected': True,
                'binanceTestnet': testnet,
                'binanceBalance': result.get('balance', {}),
                'lastSyncTime': datetime.now().isoformat(),
                'syncStatus': 'connected',
            })

        return jsonify(result)
    else:
        return jsonify(result), 400


@app.route('/api/binance/start-sync', methods=['POST'])
@require_firebase_user
def binance_start_sync():
    """Start background auto-sync for a user"""
    data = request.get_json()
    user_id = data.get('userId')
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', True)
    interval = data.get('interval', 10)

    if not user_id or not api_key or not api_secret:
        return jsonify({'status': 'error', 'message': 'Missing credentials'}), 400

    result = start_sync_for_user(user_id, api_key, api_secret, db, testnet, interval)
    return jsonify(result)


@app.route('/api/binance/stop-sync', methods=['POST'])
@require_firebase_user
def binance_stop_sync():
    """Stop background sync for a user"""
    data = request.get_json()
    user_id = data.get('userId')
    if not user_id:
        return jsonify({'status': 'error'}), 400

    result = stop_sync_for_user(user_id)

    if db:
        try:
            db.collection('users').document(user_id).update({'syncStatus': 'stopped'})
        except:
            pass

    return jsonify(result)


@app.route('/api/binance/sync-status/<user_id>', methods=['GET'])
@require_firebase_user
def binance_sync_status(user_id):
    """Get sync status for a user"""
    return jsonify(get_sync_status(user_id))


@app.route('/api/binance/sync-now', methods=['POST'])
@require_firebase_user
def binance_sync_now():
    """Trigger immediate sync for a user"""
    data = request.get_json()
    user_id = data.get('userId')
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', True)

    if not user_id or not api_key or not api_secret:
        return jsonify({'status': 'error', 'message': 'Missing credentials'}), 400

    service = BinanceSyncService(user_id, api_key, api_secret, db, testnet)
    result = service.verify_connection()

    if result['status'] != 'connected':
        return jsonify(result), 400

    new_trades = service.sync_once()
    return jsonify({
        'status': 'synced',
        'newTrades': new_trades,
        'lastSync': service.last_sync,
    })


@app.route('/api/binance/positions/<user_id>', methods=['POST'])
@require_firebase_user
def binance_positions(user_id):
    """Get open positions for a user"""
    data = request.get_json()
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', True)

    if not api_key or not api_secret:
        return jsonify({'positions': []}), 200

    service = BinanceSyncService(user_id, api_key, api_secret, db, testnet)
    result = service.verify_connection()
    if result['status'] != 'connected':
        return jsonify({'positions': [], 'error': result.get('message')}), 200

    positions = service.fetch_open_positions()
    formatted = []
    for p in positions:
        formatted.append({
            'symbol': p.get('symbol', ''),
            'side': p.get('side', ''),
            'contracts': float(p.get('contracts', 0)),
            'entryPrice': float(p.get('entryPrice', 0)),
            'markPrice': float(p.get('markPrice', 0)),
            'leverage': int(p.get('leverage', 1)),
            'marginType': p.get('marginType', 'cross'),
            'unrealizedPnl': float(p.get('unrealizedPnl', 0)),
            'percentage': float(p.get('percentage', 0)),
            'liquidationPrice': float(p.get('liquidationPrice', 0)),
            'notional': float(p.get('notional', 0)),
            'collateral': float(p.get('collateral', 0)),
        })

    return jsonify({'positions': formatted})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))

    print(f"""
    ╔════════════════════════════════════════════════════════╗
    ║  Vivek Marco Trader - Auto Trading Server v2.0        ║
    ║  Running on http://localhost:{port}                      ║
    ║                                                        ║
    ║  Webhook:  /webhook/<user_key>                         ║
    ║  Portfolio: /api/portfolio/<user_id>                    ║
    ║  Trades:   /api/trades/<user_id>                       ║
    ║                                                        ║
    ║  Exchange:  {'Connected ✅' if exchange else 'Not connected ❌'}
    ║  Firebase:  {'Connected ✅' if db else 'Not connected ❌'}
    ╚════════════════════════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=port, debug=False)
