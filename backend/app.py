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

from flask import Flask, request, jsonify, g
from flask_cors import CORS
from datetime import datetime
from functools import wraps
import hmac
import json
import math
import os
import uuid
from firebase_admin import auth as firebase_auth, firestore
from google.api_core.exceptions import Aborted
from firebase_admin_setup import initialize_firebase_services
from auth_policy import has_current_otp_proof
from exchange_registry import TenantExchangeRegistry
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
STARTUP_EXCHANGE_USER_ID = os.environ.get('STARTUP_EXCHANGE_USER_ID', '').strip()

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
LEGACY_ROUTES_ENABLED = os.environ.get('LEGACY_ROUTES_ENABLED', 'false').lower() == 'true'
LEGACY_WEBHOOK_SECRET = os.environ.get('LEGACY_WEBHOOK_SECRET', '')


SENSITIVE_LEGACY_FIELDS = {
    'apikey', 'apisecret', 'authorization', 'accesstoken', 'key', 'password',
    'privatekey', 'refreshtoken', 'secret', 'token', 'webhookkey',
}


def sanitize_legacy_payload(value, depth=0):
    """Bound retained legacy data and redact credential-shaped fields."""
    if depth > 4:
        return '[truncated]'
    if isinstance(value, dict):
        sanitized = {}
        for raw_key, item in list(value.items())[:100]:
            key = str(raw_key)[:128]
            normalized_key = ''.join(character for character in key.lower() if character.isalnum())
            if normalized_key in SENSITIVE_LEGACY_FIELDS:
                sanitized[key] = '[redacted]'
            else:
                sanitized[key] = sanitize_legacy_payload(item, depth + 1)
        return sanitized
    if isinstance(value, list):
        return [sanitize_legacy_payload(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return value[:2048]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2048]


def request_json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def positive_number(value, field_name):
    """Parse a finite number greater than zero or return a client-safe error."""
    if isinstance(value, bool):
        return None, f'{field_name} must be a positive number'
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None, f'{field_name} must be a positive number'
    if not math.isfinite(parsed) or parsed <= 0:
        return None, f'{field_name} must be a positive number'
    return parsed, None


def validate_protection_levels(side, reference_price, stop_loss, take_profit):
    """Ensure protection orders are on the safe side of a known market price."""
    if side == 'buy':
        if stop_loss is not None and stop_loss >= reference_price:
            return 'Stop loss must be below the reference price for a buy/long trade'
        if take_profit is not None and take_profit <= reference_price:
            return 'Take profit must be above the reference price for a buy/long trade'
    else:
        if stop_loss is not None and stop_loss <= reference_price:
            return 'Stop loss must be above the reference price for a sell/short trade'
        if take_profit is not None and take_profit >= reference_price:
            return 'Take profit must be below the reference price for a sell/short trade'
    return None


def run_firestore_transaction(database, operation, max_attempts=5):
    """Retry Firestore contention while re-reading all transaction state."""
    for attempt in range(max_attempts):
        transaction = database.transaction()
        try:
            result = operation(transaction)
            transaction.commit()
            return result
        except Aborted:
            if attempt == max_attempts - 1:
                raise
    raise RuntimeError('Firestore transaction attempts exhausted')


def validate_trade_input(trade_data, require_price):
    """Normalize shared demo/live order inputs before any exchange or DB write."""
    if not isinstance(trade_data, dict):
        return None, 'Trade payload must be a JSON object'

    symbol = str(trade_data.get('symbol') or 'BTC/USDT').strip().upper()[:40]
    if '/' not in symbol and symbol.endswith('USDT'):
        symbol = symbol[:-4] + '/USDT'
    if not symbol or '/' not in symbol:
        return None, 'Invalid symbol'

    action = str(trade_data.get('action') or 'buy').lower()
    if 'buy' in action or 'long' in action:
        side = 'buy'
    elif 'sell' in action or 'short' in action:
        side = 'sell'
    else:
        return None, f'Unknown action: {action[:40]}'

    quantity_value = trade_data.get(
        'qty', trade_data.get('quantity', trade_data.get('amount', 1 if require_price else 0))
    )
    quantity, error = positive_number(quantity_value, 'Quantity')
    if error:
        return None, error

    leverage_value, error = positive_number(trade_data.get('leverage', 10), 'Leverage')
    if error or not leverage_value.is_integer() or leverage_value > 125:
        return None, 'Leverage must be a whole number between 1 and 125'
    leverage = int(leverage_value)

    price = None
    if require_price:
        price, error = positive_number(trade_data.get('price'), 'Price')
        if error:
            return None, error

    optional_prices = {}
    for output_name, keys in (
        ('stopLoss', ('sl', 'stop_loss')),
        ('takeProfit', ('tp', 'take_profit')),
    ):
        raw_value = next((trade_data.get(key) for key in keys if trade_data.get(key) not in (None, '')), None)
        if raw_value is None:
            optional_prices[output_name] = None
            continue
        parsed, error = positive_number(raw_value, output_name)
        if error:
            return None, error
        optional_prices[output_name] = parsed

    if price is not None:
        protection_error = validate_protection_levels(
            side, price, optional_prices['stopLoss'], optional_prices['takeProfit']
        )
        if protection_error:
            return None, protection_error

    return {
        'symbol': symbol,
        'side': side,
        'price': price,
        'quantity': quantity,
        'leverage': leverage,
        **optional_prices,
    }, None


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
        g.auth_uid = str(uid)
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

# ===== TENANT-SCOPED EXCHANGE CONNECTIONS =====
exchange_registry = TenantExchangeRegistry()


def connect_exchange(user_id, api_key, api_secret, testnet=False):
    """Connect one authenticated user's Binance adapter without sharing state."""
    success = exchange_registry.connect(user_id, api_key, api_secret, testnet)
    if success:
        print(f"[OK] Tenant exchange connected (testnet={bool(testnet)})")
    else:
        print("[ERROR] Tenant exchange connection failed")
    return success


# Startup credentials are usable only when explicitly assigned to one tenant.
if (
    CONNECT_EXCHANGE_ON_STARTUP
    and STARTUP_EXCHANGE_USER_ID
    and BINANCE_API_KEY
    and BINANCE_API_SECRET
):
    connect_exchange(
        STARTUP_EXCHANGE_USER_ID,
        BINANCE_API_KEY,
        BINANCE_API_SECRET,
        testnet=USE_TESTNET,
    )
elif CONNECT_EXCHANGE_ON_STARTUP:
    print("[WARN] Startup exchange disabled: STARTUP_EXCHANGE_USER_ID or credentials missing")


# ===== DEMO TRADING ENGINE =====

def execute_demo_trade(user_id, trade_data):
    """Execute a virtual trade (demo mode) and save to Firebase"""
    try:
        validated, validation_error = validate_trade_input(trade_data, require_price=True)
        if validation_error:
            return {'status': 'error', 'message': validation_error}

        symbol = validated['symbol']
        side = validated['side']
        price = validated['price']
        qty = validated['quantity']
        leverage = validated['leverage']
        sl = validated['stopLoss']
        tp = validated['takeProfit']

        # Calculate margin
        position_value = price * qty
        margin = position_value / leverage
        if round(margin, 2) <= 0:
            return {'status': 'error', 'message': 'Position margin is too small'}
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

        # Persist the trade and portfolio delta atomically.
        if db:
            doc_ref = db.collection('users').document(user_id).collection('webhook_trades').document(trade['id'])
            portfolio_ref = db.collection('users').document(user_id).collection('data').document('portfolio')
            def persist_entry(transaction):
                portfolio = portfolio_ref.get(transaction=transaction)
                if portfolio.exists:
                    p = portfolio.to_dict() or {}
                    portfolio_values = {
                        'usedMargin': round(p.get('usedMargin', 0) + margin, 2),
                        'availableMargin': round(p.get('availableMargin', 100000) - margin, 2),
                        'openPositions': p.get('openPositions', 0) + 1,
                        'totalTrades': p.get('totalTrades', 0) + 1,
                        'lastUpdated': datetime.now().isoformat(),
                    }
                    portfolio_merge = True
                else:
                    portfolio_values = {
                        'balance': 100000,
                        'availableMargin': round(100000 - margin, 2),
                        'usedMargin': round(margin, 2),
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
                    }
                    portfolio_merge = False
                transaction.set(doc_ref, trade)
                transaction.set(portfolio_ref, portfolio_values, merge=portfolio_merge)

            try:
                run_firestore_transaction(db, persist_entry)
            except Exception:
                print('[ERROR] Demo trade persistence transaction failed')
                return {'status': 'error', 'message': 'Trade could not be persisted'}

        print(f"[DEMO] {side.upper()} {symbol} | Qty: {qty} | Price: ${price} | Leverage: {leverage}x | Margin: ${margin:.2f}")
        return {'status': 'executed', 'mode': 'demo', 'trade': trade}

    except Exception as e:
        print(f"[ERROR] Demo trade failed: {e}")
        return {'status': 'error', 'message': str(e)}


# ===== LIVE TRADING ENGINE =====

def execute_live_trade(user_id, trade_data):
    """Execute a real trade through the authenticated user's Binance adapter."""
    user_exchange = exchange_registry.get(user_id)
    if user_exchange is None:
        return {'status': 'error', 'message': 'Exchange not connected for this user'}

    try:
        validated, validation_error = validate_trade_input(trade_data, require_price=False)
        if validation_error:
            return {'status': 'error', 'message': validation_error}

        symbol = validated['symbol']
        side = validated['side']
        qty = validated['quantity']
        leverage = validated['leverage']
        sl = validated['stopLoss']
        tp = validated['takeProfit']

        # Validate protection levels against a current quote before placing any order.
        if sl is not None or tp is not None:
            try:
                ticker = user_exchange.fetch_ticker(symbol)
                reference_price, reference_error = positive_number(
                    (ticker or {}).get('last'), 'Reference price'
                )
            except Exception:
                return {'status': 'error', 'message': 'Unable to validate protection levels'}
            if reference_error:
                return {'status': 'error', 'message': reference_error}
            protection_error = validate_protection_levels(side, reference_price, sl, tp)
            if protection_error:
                return {'status': 'error', 'message': protection_error}

        # Set leverage
        try:
            user_exchange.set_leverage(leverage, symbol.replace('/', ''))
        except:
            pass

        # Execute market order
        order = user_exchange.create_market_order(symbol, side, qty)
        fill_price = float(order.get('average', order.get('price', 0)))
        filled_qty = float(order.get('filled', qty))

        post_fill_protection_error = validate_protection_levels(side, fill_price, sl, tp)
        if post_fill_protection_error:
            close_side = 'sell' if side == 'buy' else 'buy'
            try:
                emergency_order = user_exchange.create_order(
                    symbol,
                    'market',
                    close_side,
                    filled_qty,
                    None,
                    {'reduceOnly': True},
                )
                return {
                    'status': 'error',
                    'message': 'Protection levels became invalid after fill; position was immediately closed',
                    'emergencyClosed': True,
                    'entryOrderId': order.get('id'),
                    'closeOrderId': emergency_order.get('id'),
                }
            except Exception:
                return {
                    'status': 'error',
                    'message': 'URGENT: protection invalid after fill and emergency close failed',
                    'emergencyClosed': False,
                    'entryOrderId': order.get('id'),
                }

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
                sl_order = user_exchange.create_order(symbol, 'stop_market', sl_side, filled_qty, None, {'stopPrice': float(sl)})
                sl_order_id = sl_order.get('id')
            except Exception as e:
                print(f"[WARN] SL order failed: {e}")

        if tp:
            try:
                tp_side = 'sell' if side == 'buy' else 'buy'
                tp_order = user_exchange.create_order(symbol, 'take_profit_market', tp_side, filled_qty, None, {'stopPrice': float(tp)})
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
        'exchange_connected': exchange_registry.connected_count() > 0,
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

        # Parse and validate before retaining an alert or acknowledging success.
        if request.is_json:
            data = request.get_json(silent=True)
        else:
            try:
                data = json.loads(request.data.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                data = None
        if not isinstance(data, dict):
            return jsonify({'status': 'error', 'message': 'JSON object required'}), 400

        live_enabled = user_mode == 'live' and LEGACY_WEBHOOK_LIVE_ENABLED
        _, validation_error = validate_trade_input(data, require_price=not live_enabled)
        if validation_error:
            return jsonify({'status': 'error', 'message': validation_error}), 400

        result = execute_live_trade(user_id, data) if live_enabled else execute_demo_trade(user_id, data)
        if result.get('status') == 'error':
            return jsonify({'status': 'error', 'message': result.get('message', 'Trade rejected')}), 422

        alert = {
            'id': f'alert_{int(datetime.now().timestamp() * 1000)}',
            'userId': user_id,
            'data': sanitize_legacy_payload(data),
            'receivedAt': datetime.now().isoformat(),
            'mode': user_mode,
        }
        if db:
            db.collection('users').document(user_id).collection('webhook_alerts').add(alert)

        print(f"[WEBHOOK] User: {user_id} | Mode: {user_mode} | Action: {data.get('action', 'unknown')}")
        return jsonify({'status': 'success', 'alert': alert, 'trade': result}), 200

    except Exception as e:
        print(f"[ERROR] Webhook: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/webhook', methods=['POST'])
def webhook_legacy():
    """Compatibility webhook; disabled by default and never accepts anonymous trades."""
    if not LEGACY_ROUTES_ENABLED:
        return jsonify({
            'status': 'error',
            'message': 'Legacy webhook disabled; use /webhook/<user_key> or /webhook/v1/<endpoint_id>',
        }), 410
    if not LEGACY_WEBHOOK_SECRET:
        return jsonify({'status': 'error', 'message': 'Legacy webhook unavailable'}), 503

    provided_secret = request.headers.get('X-Legacy-Webhook-Secret', '')
    if not provided_secret or not hmac.compare_digest(provided_secret, LEGACY_WEBHOOK_SECRET):
        return jsonify({'status': 'error', 'message': 'Webhook authentication failed'}), 401

    try:
        if request.is_json:
            data = request.get_json(silent=True)
        else:
            data = json.loads(request.data.decode('utf-8'))
        if not isinstance(data, dict):
            return jsonify({'status': 'error', 'message': 'JSON object required'}), 400

        webhook_key = data.get('key', data.get('webhook_key', data.get('secret', '')))
        if not webhook_key or not db:
            return jsonify({'status': 'error', 'message': 'Valid user webhook key required'}), 401

        user_id = None
        user_mode = 'demo'
        users_ref = db.collection('users')
        query_result = users_ref.where('webhookKey', '==', webhook_key).limit(1).get()
        for doc_snap in query_result:
            user_id = doc_snap.id
            user_data = doc_snap.to_dict()
            user_mode = user_data.get('tradingMode', 'demo')
            break
        if not user_id:
            return jsonify({'status': 'error', 'message': 'Valid user webhook key required'}), 401

        live_enabled = user_mode == 'live' and LEGACY_WEBHOOK_LIVE_ENABLED
        _, validation_error = validate_trade_input(data, require_price=not live_enabled)
        if validation_error:
            return jsonify({'status': 'error', 'message': validation_error}), 400

        trade_result = execute_live_trade(user_id, data) if live_enabled else execute_demo_trade(user_id, data)
        if trade_result.get('status') == 'error':
            return jsonify({'status': 'error', 'message': trade_result.get('message', 'Trade rejected')}), 422

        alert = {
            'id': f'alert_{int(datetime.now().timestamp() * 1000)}',
            'userId': user_id,
            'action': data.get('action', 'ALERT'),
            'symbol': data.get('symbol', 'Unknown'),
            'price': data.get('price', 0),
            'qty': data.get('qty', data.get('quantity', data.get('amount', 1))),
            'leverage': data.get('leverage', 10),
            'sl': data.get('sl'),
            'tp': data.get('tp'),
            'data': sanitize_legacy_payload(data),
            'receivedAt': datetime.now().isoformat(),
            'mode': user_mode,
        }
        memory_alerts.insert(0, alert)
        del memory_alerts[200:]
        db.collection('users').document(user_id).collection('webhook_alerts').add(alert)

        print(f"[WEBHOOK] User: {user_id} | Action: {alert['action']} | Symbol: {alert['symbol']}")
        return jsonify({'status': 'success', 'alert': alert, 'trade': trade_result}), 200
    except Exception:
        print('[ERROR] Legacy webhook processing failed')
        return jsonify({'status': 'error', 'message': 'Webhook processing failed'}), 400


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
    """Close a trade and update portfolio accounting in one transaction."""
    if not db:
        return jsonify({'status': 'error', 'message': 'Database unavailable'}), 503

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'status': 'error', 'message': 'JSON object required'}), 400
    exit_price, validation_error = positive_number(
        data.get('exitPrice', data.get('price')), 'Exit price'
    )
    if validation_error:
        return jsonify({'status': 'error', 'message': validation_error}), 400

    trade_ref = db.collection('users').document(user_id).collection('webhook_trades').document(trade_id)
    portfolio_ref = db.collection('users').document(user_id).collection('data').document('portfolio')
    def perform_close(transaction):
        trade_doc = trade_ref.get(transaction=transaction)
        portfolio_doc = portfolio_ref.get(transaction=transaction)
        if not trade_doc.exists:
            return {'outcome': 'not_found'}

        trade = trade_doc.to_dict() or {}
        if trade.get('status') != 'open':
            return {'outcome': 'already_closed'}

        entry, entry_error = positive_number(trade.get('entryPrice'), 'Stored entry price')
        qty, qty_error = positive_number(trade.get('quantity'), 'Stored quantity')
        margin, margin_error = positive_number(trade.get('margin'), 'Stored margin')
        if entry_error or qty_error or margin_error or trade.get('side') not in ('buy', 'sell'):
            return {'outcome': 'invalid_trade'}

        pnl = (exit_price - entry) * qty if trade['side'] == 'buy' else (entry - exit_price) * qty
        roi = (pnl / margin) * 100
        closed_at = datetime.now().isoformat()
        transaction.update(trade_ref, {
            'status': 'closed',
            'exitPrice': exit_price,
            'pnl': round(pnl, 2),
            'roi': round(roi, 2),
            'closedAt': closed_at,
        })

        if portfolio_doc.exists:
            portfolio = portfolio_doc.to_dict() or {}

            def portfolio_number(key, default=0):
                try:
                    value = float(portfolio.get(key, default))
                    return value if math.isfinite(value) else float(default)
                except (TypeError, ValueError):
                    return float(default)

            is_win = pnl > 0
            wins = int(portfolio_number('wins')) + (1 if is_win else 0)
            losses = int(portfolio_number('losses')) + (0 if is_win else 1)
            total_trades = max(1, int(portfolio_number('totalTrades', 1)))
            transaction.update(portfolio_ref, {
                'usedMargin': round(max(0, portfolio_number('usedMargin') - margin), 2),
                'availableMargin': round(portfolio_number('availableMargin', 100000) + margin + pnl, 2),
                'balance': round(portfolio_number('balance', 100000) + pnl, 2),
                'openPositions': max(0, int(portfolio_number('openPositions')) - 1),
                'realizedPnl': round(portfolio_number('realizedPnl') + pnl, 2),
                'totalPnl': round(portfolio_number('totalPnl') + pnl, 2),
                'wins': wins,
                'losses': losses,
                'winRate': round((wins / total_trades) * 100, 1),
                'lastUpdated': closed_at,
            })
        return {'outcome': 'closed', 'pnl': pnl, 'roi': roi}

    try:
        result = run_firestore_transaction(db, perform_close)
    except Exception:
        print('[ERROR] Trade close transaction failed')
        return jsonify({'status': 'error', 'message': 'Trade close could not be persisted'}), 503

    if result['outcome'] == 'not_found':
        return jsonify({'status': 'error', 'message': 'Trade not found'}), 404
    if result['outcome'] == 'already_closed':
        return jsonify({'status': 'error', 'message': 'Trade already closed'}), 409
    if result['outcome'] == 'invalid_trade':
        return jsonify({'status': 'error', 'message': 'Trade data is invalid'}), 422
    return jsonify({
        'status': 'closed',
        'pnl': round(result['pnl'], 2),
        'roi': round(result['roi'], 2),
    })


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

    data = request_json_object()
    mode = data.get('mode')

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
    data = request_json_object()
    api_key = data.get('apiKey', '')
    api_secret = data.get('apiSecret', '')
    testnet = data.get('testnet', False)
    if not api_key or not api_secret:
        return jsonify({'status': 'error', 'message': 'apiKey and apiSecret are required'}), 400

    success = connect_exchange(user_id, api_key, api_secret, testnet)

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
        'exchange': exchange_registry.connected_count() > 0,
        'firebase': db is not None,
        'alerts_count': len(memory_alerts),
        'trades_count': len(memory_trades),
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/alerts', methods=['GET'])
@require_firebase_user
def get_alerts():
    """Get only the authenticated tenant's retained legacy alerts."""
    limit = max(1, min(request.args.get('limit', 50, type=int), 200))
    alerts = [item for item in memory_alerts if str(item.get('userId')) == g.auth_uid]
    return jsonify({'alerts': alerts[:limit], 'total': len(alerts)})


@app.route('/trades', methods=['GET'])
@require_firebase_user
def get_memory_trades():
    """Get only the authenticated tenant's retained legacy trades."""
    trades = [item for item in memory_trades if str(item.get('userId')) == g.auth_uid]
    return jsonify({'trades': trades, 'total': len(trades)})


# ==================== BINANCE SYNC ENDPOINTS ====================

@app.route('/api/binance/connect', methods=['POST'])
@require_firebase_user
def binance_connect():
    """Verify and connect Binance Futures Testnet API"""
    data = request_json_object()
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
    data = request_json_object()
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
    data = request_json_object()
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
    data = request_json_object()
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
    data = request_json_object()
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
    ║  Exchange:  {'Connected ✅' if exchange_registry.connected_count() > 0 else 'Not connected ❌'}
    ║  Firebase:  {'Connected ✅' if db else 'Not connected ❌'}
    ╚════════════════════════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=port, debug=False)
