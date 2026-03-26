#!/usr/bin/env python3
"""
Live TV channel API
Endpoints:
  POST /api/channel    { "channel": "7.1" }  — switch channel
  POST /api/heartbeat                         — viewer keepalive
  GET  /api/guide                             — EPG guide from Plex
"""

import os
import time
import json
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

CHANNEL_FILE   = '/config/channel'
HEARTBEAT_FILE = '/config/heartbeat'
PLEX_HOST      = os.environ.get('PLEX_HOST', 'http://localhost:32400')
PLEX_TOKEN     = os.environ.get('PLEX_TOKEN', '')

def read_channel():
    try:
        with open(CHANNEL_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return os.environ.get('DEFAULT_CHANNEL', '7.1')

def write_channel(channel):
    os.makedirs('/config', exist_ok=True)
    with open(CHANNEL_FILE, 'w') as f:
        f.write(channel.strip())

def write_heartbeat():
    os.makedirs('/config', exist_ok=True)
    with open(HEARTBEAT_FILE, 'w') as f:
        f.write(str(int(time.time())))

@app.route('/api/channel', methods=['POST'])
def set_channel():
    data = request.get_json(silent=True) or {}
    channel = str(data.get('channel', '')).strip()
    if not channel:
        return jsonify({'error': 'channel required'}), 400
    write_channel(channel)
    write_heartbeat()
    return jsonify({'channel': channel})

@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    write_heartbeat()
    return jsonify({'ok': True, 'channel': read_channel()})

@app.route('/api/guide', methods=['GET'])
def guide():
    """Fetch EPG guide data from Plex DVR."""
    try:
        headers = {'Accept': 'application/json'}
        if PLEX_TOKEN:
            headers['X-Plex-Token'] = PLEX_TOKEN
        resp = requests.get(
            f'{PLEX_HOST}/livetv/dvrs',
            headers=headers,
            timeout=10
        )
        resp.raise_for_status()
        data = resp.json()
        # Extract channels from Plex DVR response
        channels = []
        dvrs = data.get('MediaContainer', {}).get('Dvr', [])
        for dvr in dvrs:
            for ch in dvr.get('Device', {}).get('Channel', []):
                channels.append({
                    'number':  ch.get('channelNumber', ''),
                    'title':   ch.get('channelTitle', '') or ch.get('channelCallSign', ''),
                    'thumb':   ch.get('thumb', None),
                })
        return jsonify({'channels': channels})
    except Exception as e:
        # Return empty guide rather than error — Plex EPG is optional
        return jsonify({'channels': [], 'error': str(e)})

if __name__ == '__main__':
    # Write initial heartbeat so ffmpeg starts immediately
    write_heartbeat()
    app.run(host='0.0.0.0', port=8080)
