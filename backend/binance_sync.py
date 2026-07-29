"""
Binance Futures Testnet - Auto Trade Sync Service
==================================================
Fetches closed trades from Binance Futures Testnet every 10 seconds.
Stores new trades in Firebase Firestore under users/{uid}/trades/
Never creates duplicates. Updates existing trades if position closes.

Supports: Orders, Positions, Trade History
"""

import ccxt
import time
import threading
from datetime import datetime, timedelta

# Active sync threads per user
active_syncs = {}


class BinanceSyncService:
    """Per-user Binance Futures Testnet sync service"""

    def __init__(self, user_id, api_key, api_secret, db=None, testnet=True):
        self.user_id = user_id
        self.db = db
        self.running = False
        self.last_sync = None
        self.error = None
        self.synced_trade_ids = set()

        # Initialize exchange
        self.exchange = ccxt.binance({
            'apiKey': api_key,
            'secret': api_secret,
            'sandbox': testnet,
            'options': {
                'defaultType': 'future',
                'adjustForTimeDifference': True,
            },
            'enableRateLimit': True,
        })

    def verify_connection(self):
        """Verify API keys and return account info"""
        try:
            balance = self.exchange.fetch_balance()
            futures_balance = balance.get('USDT', {})
            return {
                'status': 'connected',
                'balance': {
                    'total': futures_balance.get('total', 0),
                    'free': futures_balance.get('free', 0),
                    'used': futures_balance.get('used', 0),
                },
                'timestamp': datetime.now().isoformat(),
            }
        except ccxt.AuthenticationError:
            return {'status': 'error', 'message': 'Invalid API Key or Secret'}
        except ccxt.NetworkError:
            return {'status': 'error', 'message': 'Network error. Check internet connection.'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    def fetch_closed_trades(self, since_hours=24):
        """Fetch recent closed trades from Binance Futures"""
        try:
            since = int((datetime.now() - timedelta(hours=since_hours)).timestamp() * 1000)

            # Fetch all recent trades for common pairs
            symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
                       'DOGE/USDT', 'ADA/USDT', 'DOT/USDT', 'MATIC/USDT', 'AVAX/USDT',
                       'LINK/USDT', 'UNI/USDT', 'ATOM/USDT', 'FTM/USDT', 'NEAR/USDT']

            all_trades = []
            for symbol in symbols:
                try:
                    trades = self.exchange.fetch_my_trades(symbol, since=since, limit=50)
                    all_trades.extend(trades)
                except:
                    continue

            return all_trades
        except Exception as e:
            self.error = str(e)
            return []

    def fetch_open_positions(self):
        """Fetch currently open positions"""
        try:
            positions = self.exchange.fetch_positions()
            # Filter only open positions (non-zero)
            open_positions = [p for p in positions if float(p.get('contracts', 0)) > 0]
            return open_positions
        except Exception as e:
            self.error = str(e)
            return []

    def fetch_income_history(self, since_hours=24):
        """Fetch realized PNL from income history"""
        try:
            since = int((datetime.now() - timedelta(hours=since_hours)).timestamp() * 1000)
            # Binance specific: fetch income (realized PNL entries)
            params = {'incomeType': 'REALIZED_PNL', 'startTime': since}
            income = self.exchange.fapiPrivateGetIncome(params)
            return income if isinstance(income, list) else []
        except:
            return []

    def process_trade(self, raw_trade):
        """Convert raw exchange trade to journal format"""
        trade_id = str(raw_trade.get('id', ''))
        order_id = str(raw_trade.get('order', ''))

        symbol = raw_trade.get('symbol', '')
        side = raw_trade.get('side', 'buy').lower()
        price = float(raw_trade.get('price', 0))
        qty = float(raw_trade.get('amount', 0))
        cost = float(raw_trade.get('cost', 0))
        fee = raw_trade.get('fee', {})
        fee_cost = float(fee.get('cost', 0)) if fee else 0
        timestamp = raw_trade.get('timestamp', 0)

        # Determine long/short
        position_side = raw_trade.get('info', {}).get('positionSide', 'BOTH')
        if position_side == 'LONG' or (position_side == 'BOTH' and side == 'buy'):
            trade_type = 'long'
        else:
            trade_type = 'short'

        trade = {
            'tradeId': trade_id,
            'orderId': order_id,
            'symbol': symbol,
            'side': side,
            'type': trade_type,
            'entryPrice': price,
            'exitPrice': None,
            'quantity': qty,
            'leverage': 1,
            'marginType': 'cross',
            'positionSize': cost,
            'openTime': datetime.fromtimestamp(timestamp / 1000).isoformat() if timestamp else None,
            'closeTime': None,
            'duration': None,
            'realizedPnl': 0,
            'roi': 0,
            'fees': abs(fee_cost),
            'status': 'open',
            'winLoss': None,
            'netProfit': 0,
            'source': 'binance_testnet',
            'syncedAt': datetime.now().isoformat(),
        }
        return trade

    def process_income_pnl(self, income_entry):
        """Convert income/PNL entry to closed trade format"""
        symbol = income_entry.get('symbol', '')
        if not symbol.endswith('USDT'):
            symbol = symbol + '/USDT' if '/' not in symbol else symbol
        else:
            symbol = symbol[:-4] + '/USDT' if '/' not in symbol else symbol

        pnl = float(income_entry.get('income', 0))
        timestamp = int(income_entry.get('time', 0))
        trade_id = income_entry.get('tradeId', str(timestamp))

        return {
            'tradeId': f'pnl_{trade_id}',
            'symbol': symbol,
            'realizedPnl': pnl,
            'closeTime': datetime.fromtimestamp(timestamp / 1000).isoformat() if timestamp else None,
            'status': 'closed',
            'winLoss': 'win' if pnl > 0 else 'loss' if pnl < 0 else 'breakeven',
            'netProfit': pnl,
            'source': 'binance_testnet',
            'syncedAt': datetime.now().isoformat(),
        }

    def sync_once(self):
        """Perform one sync cycle"""
        try:
            # 1. Fetch closed trades (realized PNL)
            income = self.fetch_income_history(since_hours=72)
            new_trades_count = 0

            for entry in income:
                trade_id = f"pnl_{entry.get('tradeId', entry.get('time', ''))}"

                # Skip if already synced
                if trade_id in self.synced_trade_ids:
                    continue

                trade_data = self.process_income_pnl(entry)

                # Save to Firebase
                if self.db:
                    doc_ref = self.db.collection('users').document(self.user_id) \
                        .collection('trades').document(trade_id)
                    # Check if exists
                    existing = doc_ref.get()
                    if not existing.exists:
                        doc_ref.set(trade_data)
                        new_trades_count += 1
                    else:
                        # Update if PNL changed
                        doc_ref.update({
                            'realizedPnl': trade_data['realizedPnl'],
                            'status': 'closed',
                            'winLoss': trade_data['winLoss'],
                            'netProfit': trade_data['netProfit'],
                            'syncedAt': trade_data['syncedAt'],
                        })

                self.synced_trade_ids.add(trade_id)

            # 2. Fetch and save raw trades
            raw_trades = self.fetch_closed_trades(since_hours=72)
            for raw in raw_trades:
                trade_id = f"t_{raw.get('id', '')}"
                if trade_id in self.synced_trade_ids:
                    continue

                trade_data = self.process_trade(raw)
                trade_data['tradeId'] = trade_id

                if self.db:
                    doc_ref = self.db.collection('users').document(self.user_id) \
                        .collection('trades').document(trade_id)
                    existing = doc_ref.get()
                    if not existing.exists:
                        doc_ref.set(trade_data)
                        new_trades_count += 1

                self.synced_trade_ids.add(trade_id)

            # 3. Update sync status
            if self.db:
                self.db.collection('users').document(self.user_id).update({
                    'lastSyncTime': datetime.now().isoformat(),
                    'syncStatus': 'active',
                    'syncError': None,
                    'newTradesCount': new_trades_count,
                })

            self.last_sync = datetime.now().isoformat()
            self.error = None
            return new_trades_count

        except Exception as e:
            self.error = str(e)
            if self.db:
                try:
                    self.db.collection('users').document(self.user_id).update({
                        'syncStatus': 'error',
                        'syncError': str(e),
                    })
                except:
                    pass
            return 0

    def start_background_sync(self, interval=10):
        """Start background sync thread (runs every `interval` seconds)"""
        if self.running:
            return

        self.running = True

        def sync_loop():
            while self.running:
                self.sync_once()
                time.sleep(interval)

        thread = threading.Thread(target=sync_loop, daemon=True)
        thread.start()
        print(f"[SYNC] Started for user {self.user_id} (every {interval}s)")

    def stop(self):
        """Stop background sync"""
        self.running = False
        if self.user_id in active_syncs:
            del active_syncs[self.user_id]
        print(f"[SYNC] Stopped for user {self.user_id}")


def start_sync_for_user(user_id, api_key, api_secret, db=None, testnet=True, interval=10):
    """Start or restart sync for a user"""
    # Stop existing sync if any
    if user_id in active_syncs:
        active_syncs[user_id].stop()

    service = BinanceSyncService(user_id, api_key, api_secret, db, testnet)
    result = service.verify_connection()

    if result['status'] == 'connected':
        service.start_background_sync(interval)
        active_syncs[user_id] = service
        return {'status': 'started', 'balance': result.get('balance')}
    else:
        return result


def stop_sync_for_user(user_id):
    """Stop sync for a user"""
    if user_id in active_syncs:
        active_syncs[user_id].stop()
        return {'status': 'stopped'}
    return {'status': 'not_running'}


def get_sync_status(user_id):
    """Get current sync status"""
    if user_id in active_syncs:
        service = active_syncs[user_id]
        return {
            'status': 'running',
            'lastSync': service.last_sync,
            'error': service.error,
            'syncedTrades': len(service.synced_trade_ids),
        }
    return {'status': 'stopped'}
