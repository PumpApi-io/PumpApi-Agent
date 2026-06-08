'''
EXAMPLE STRATEGY: AFTER EXTENSIVE CLARIFICATION WITH THE USER, WE DECIDED TO BUY 0.001 SOL OR USDC EQUIVALENT ALL NEW TOKENS WITH AN INITIAL DEV PURCHASE > 20 SOL. TP: 50%, SL: 20%, IDLE TIME: 5 MIN. WE SUPPORT NATIVE SOLANA AND USDC AS QUOTE MINTS. NOTIFICATIONS: EVERY BUY OR SELL ACTION, PLUS GENERAL STATISTICS EVERY 30 MINUTES.
'''

import asyncio
import aiohttp
import websockets
import orjson as json
import logging
from cachetools import TTLCache,LRUCache
import traceback
from collections import defaultdict
import time
from notify_user import notify

CHAT_ID = # CHAT ID YOU GOT USING NOTIFY USER SKILL
PLATFORM = # PLATFORM YOU GOT USING NOTIFY USER SKILL
MY_SOLANA_B58_PRIVATE_KEY = # YOUR PRIVATE KEY FROM /etc/environment
MY_SOLANA_B58_PUBLIC_KEY = # YOUR PUBLIC KEY FROM /etc/environment

processed_signatures = TTLCache(maxsize=10000, ttl=300)

WSOL = 'So11111111111111111111111111111111111111112'
USDC  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
global_dict = {'sol_price': 80}
SOL_BUY_THRESHOLD = 20 # pump fee is 1.25%, so it’s disadvantageous for any dev to sell right after creation because the loss will be around 0.5 SOL
SOL_AMOUNT_TO_BUY = 0.001
strategy_dict = {WSOL: {'buy_threshold': SOL_BUY_THRESHOLD, 'amount_to_buy': SOL_AMOUNT_TO_BUY, 'ui_name': 'sol','post_balances_field_name': 'sol'},
                 USDC: {'buy_threshold': SOL_BUY_THRESHOLD*global_dict['sol_price'], 'amount_to_buy': SOL_AMOUNT_TO_BUY*global_dict['sol_price'], 'ui_name': 'USDC', 'post_balances_field_name': USDC}}
TP = 50
SL = 20
bought_mints = defaultdict(dict)
our_balances = {}

logging.basicConfig(
    handlers=[
        logging.FileHandler("logs_for_agent.log", mode="w", encoding="utf-8"),
        logging.StreamHandler()
    ],
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

async def make_pumpapi_trade(aiohttp_session, action, mint_address, quote_mint_address, amount, slippage, price):
    logging.info(f"initial purchase more than our threshold -> buying {amount} {quote_mint_address}!")
    try:
        if mint_address not in bought_mints:
            bought_mints[mint_address] = {'quote_mint_address': quote_mint_address,'buy_confirmed': False, 'sell_confirmed': False, "quote_amount_spent": amount* ( 1 + (1 / int(slippage)) ), "entry_price": price, "entry_time": time.time()}
        else:
            if action == 'buy':
                logging.info(f'Mint {mint_address} already bought - skip')
                return
        async with aiohttp_session.post(
            url=f"https://api.pumpapi.io",
            data={
                "privateKey": MY_SOLANA_B58_PRIVATE_KEY,
                "action": action,
                "mint": mint_address,
                "quoteMint": quote_mint_address,
                "amount": amount,
                "denominatedInQuote": "true",
                "slippage": slippage,
            }
        ) as response:
            response = await response.json()
            our_purchase_event = None
            for i in range (30): # wait  3 sec to get tx from the data stream - no tx - skip.
                await asyncio.sleep(0.1)
                events_from_our_tx = processed_signatures.get(response['signature'], [])
                for event in events_from_our_tx:
                    if event['action'] == action and event['mint'] == mint_address:
                        our_purchase_event = event
                    if our_purchase_event:
                        # WE FOUND OUR OWN TRANSACTION IN DATA STREAM

                        quote_balance = our_purchase_event['postBalances'][MY_SOLANA_B58_PUBLIC_KEY][strategy_dict[quote_mint_address]['post_balances_field_name']] # WSOL account is temporary. When trading through PumpApi, the WSOL account is always closed after the trade, so we should look at the native SOL balance. (sol)
                        ui_quote_name = strategy_dict[quote_mint_address]['ui_name']
                        our_balances[quote_mint_address] = quote_balance
                        if action == 'buy':
                            bought_mints[mint_address]['buy_confirmed'] = True
                            bought_mints[mint_address]['quote_amount_spent'] = our_purchase_event['quoteAmount']
                            bought_mints[mint_address]['entry_price'] = our_purchase_event['price']
                            logging.info(f'BUY SUCCESS! {our_purchase_event}\n {ui_quote_name} balance - {quote_balance}')
                            notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"Token {mint_address} bought. {our_purchase_event['tokenAmount']} for {our_purchase_event['quoteAmount']} {ui_quote_name} balance - {quote_balance}")
                        elif action == 'sell':
                            bought_mints[mint_address]['sell_confirmed'] = True
                            bought_mints[mint_address]['quote_amount_got'] = our_purchase_event['quoteAmount']
                            bought_mints[mint_address]['exit_price'] = our_purchase_event['price']
                            quote_amount_got = bought_mints[mint_address]['quote_amount_got']
                            quote_amount_spent = bought_mints[mint_address]['quote_amount_spent']
                            profit = quote_amount_got - quote_amount_spent
                            logging.info(f'{our_purchase_event}\nSELL SUCCESS!\nPROFIT {profit} quote mint - {ui_quote_name}\n balance - {quote_balance}')
                            notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"Token {mint_address} sold. Profit: {profit}\n quote mint - {ui_quote_name} balance - {quote_balance}")

                        break
                if our_purchase_event:
                    break
    except:
        logging.info(f'ERROR! traceback in make_pumpapi_trade --> {traceback.format_exc()}')


def reset_after_sell(token_events, bought_mints, mint_address):
    bought_mints.pop(mint_address,None)
    # wipe the queue
    while not token_events[mint_address].empty():
        token_events[mint_address].get_nowait()
    token_events[mint_address].put_nowait({'action': 'exit'})
    return


async def handle_bot_token(aiohttp_session, token_events, mint_address, initial_quote_mint_address):
    try:
        do_sell = False
        while True:
            try:
                event = await asyncio.wait_for(token_events[mint_address].get(), timeout=300)
            except TimeoutError:
                logging.info('No activity - sell.')
                bought_mint_dict = bought_mints[mint_address]
                if not bought_mint_dict.get('buy_confirmed'):
                    logging.info(f'{mint_address}: buy not confirmed, nothing to sell')
                    reset_after_sell(token_events=token_events, bought_mints=bought_mints, mint_address=mint_address)
                    continue
                do_sell = True
                event = {"action": None} # to prevent undefined error


            if event['action'] == 'create':
                quote_mint_address = event['quoteMint']
                logging.info(f"Found legit create event: {event}")
                if ((quote_mint_address == WSOL or quote_mint_address == USDC) and event['quoteAmount'] > strategy_dict[quote_mint_address]['buy_threshold']):
                    asyncio.create_task(make_pumpapi_trade(aiohttp_session=aiohttp_session, action='buy', mint_address=mint_address, quote_mint_address=quote_mint_address, amount=strategy_dict[quote_mint_address]['amount_to_buy'], slippage=20, price = event['price']))
                else:
                    logging.info(f"Initial buy is less than buy_threshold")
                    return
            elif event['action'] in ['buy', 'sell', 'add', 'remove']:
                bought_mint_dict = bought_mints[mint_address]
                if event['pool'] == 'pump' or (event['pool'] == 'pump-amm' and event['poolCreatedBy'] == 'pump'):
                    buy_price = bought_mint_dict['entry_price']
                    current_price = event['price']
                    profit_percentage = ((current_price - buy_price) / buy_price) * 100
                    if profit_percentage > TP:
                        do_sell = True
                    elif profit_percentage < -SL:
                        do_sell = True
            elif event['action'] == 'exit':
                logging.info(f'got exit for {mint_address}')
                return
            if do_sell:
                await make_pumpapi_trade(aiohttp_session=aiohttp_session, action='sell', mint_address=mint_address, quote_mint_address=initial_quote_mint_address, amount='100%', slippage=99, price = None)
                reset_after_sell(token_events=token_events, bought_mints=bought_mints, mint_address=mint_address)
    except:
        logging.info(f'ERROR! traceback in handle_bot_token --> {traceback.format_exc()}')

async def pumpapi_data_stream(ws_url, aiohttp_session, token_events):
    async with websockets.connect(ws_url) as websocket:
        async for message in websocket:
            event = json.loads(message)
            signature = event['signature']
            if signature in processed_signatures:
                processed_signatures[signature].append(event)
            else:
                processed_signatures[signature] = [event]
            mint_address = event.get('mint')
            if event.get('poolId') == 'Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v': # not every event has poolId that's why we use .get() | this is major trusted SOL-USDC pool
                sol_price = 1/event['price']
                global_dict['sol_price'] = sol_price
                logging.info(f"Current sol price is {sol_price}")
                strategy_dict[USDC]['buy_threshold'] = strategy_dict[WSOL]['buy_threshold'] * sol_price # adjustment by price
                strategy_dict[USDC]['amount_to_buy'] = strategy_dict[WSOL]['amount_to_buy'] * sol_price # adjustment by price

            elif event['action'] == 'create' and event['pool'] == 'pump' and not event['mayhemMode']:
                asyncio.create_task(handle_bot_token(aiohttp_session = aiohttp_session, token_events = token_events, mint_address = mint_address, initial_quote_mint_address = event['quoteMint']))
                token_events[mint_address].put_nowait(event)

            elif mint_address in bought_mints:
                token_events[mint_address].put_nowait(event)

async def periodical_notifier():
    while True:
        try:
            await asyncio.sleep(30)
            if our_balances:
                logging.info(f"Current balances: {our_balances}")
                notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"Current balances: {our_balances}")
            else:
                logging.info(f"No balance changes yet")
                notify(platform = PLATFORM, chat_id = CHAT_ID, text=f"No balance changes yet")
        except:
            logging.info(f'ERROR! traceback in make_pumpapi_trade --> {traceback.format_exc()}')

async def start_bot():
    ws_url = "wss://stream.pumpapi.io/"
    aiohttp_session = aiohttp.ClientSession()
    token_events = defaultdict(asyncio.Queue)
    asyncio.create_task(periodical_notifier())
    while True:
        try:
            await pumpapi_data_stream(ws_url = ws_url, aiohttp_session = aiohttp_session, token_events = token_events)
        except:
            logging.info(f'ERROR! traceback in pumpapi_data_stream --> {traceback.format_exc()}')
            await asyncio.sleep(0.4)




asyncio.run(start_bot())
