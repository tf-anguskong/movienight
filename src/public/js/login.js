const params = new URLSearchParams(location.search);
const messages = {
  plex: 'Could not connect to Plex. Please try again.',
  no_token: 'Authorization was not completed. Please try again.',
  access: "You don't have access to this Plex server.",
  auth: 'Authentication failed. Please try again.'
};
const error = params.get('error');
if (error && messages[error]) {
  const el = document.getElementById('error-msg');
  el.textContent = messages[error];
  el.style.display = 'block';
}
