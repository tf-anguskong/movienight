const inviteToken = location.pathname.split('/').pop();

async function joinRoom() {
  const name = document.getElementById('guest-name').value.trim();
  if (!name) { document.getElementById('guest-name').focus(); return; }

  const btn = document.getElementById('join-btn');
  btn.disabled = true; btn.textContent = '…';

  try {
    // Validate the invite and get the roomId
    const validateRes = await fetch(`/join/${inviteToken}/info`);
    if (!validateRes.ok) throw new Error('Invite link is no longer valid.');
    const { roomId } = await validateRes.json();

    const res = await fetch('/auth/guest-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, inviteToken, roomId })
    });
    const data = await res.json();
    if (data.ok) window.location.href = `/watch/${data.roomId}?autoplay=1`;
    else throw new Error(data.error || 'Failed to join.');
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Join →';
    const el = document.getElementById('error-msg');
    el.textContent = err.message;
    el.style.display = 'block';
  }
}

document.getElementById('join-btn').addEventListener('click', joinRoom);
document.getElementById('guest-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});
