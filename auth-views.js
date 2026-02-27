const { esc } = require('./views');

function renderLoginPage(error) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Expense Report</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="auth-container">
    <div class="auth-card">
      <h1>Expense Report</h1>
      <h2>Sign In</h2>
      ${error ? `<div class="auth-error">${esc(error)}</div>` : ''}
      <form method="POST" action="/login" class="auth-form">
        <div class="auth-field">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username">
        </div>
        <div class="auth-field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary auth-submit">Sign In</button>
      </form>
      <p class="auth-link">Don't have an account? <a href="/register">Create one</a></p>
    </div>
  </div>
</body>
</html>`;
}

function renderRegisterPage(error) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Register — Expense Report</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="auth-container">
    <div class="auth-card">
      <h1>Expense Report</h1>
      <h2>Create Account</h2>
      ${error ? `<div class="auth-error">${esc(error)}</div>` : ''}
      <form method="POST" action="/register" class="auth-form">
        <div class="auth-field">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username" minlength="3" maxlength="32">
        </div>
        <div class="auth-field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8">
        </div>
        <div class="auth-field">
          <label for="confirmPassword">Confirm Password</label>
          <input type="password" id="confirmPassword" name="confirmPassword" required autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary auth-submit">Create Account</button>
      </form>
      <p class="auth-link">Already have an account? <a href="/login">Sign in</a></p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { renderLoginPage, renderRegisterPage };
