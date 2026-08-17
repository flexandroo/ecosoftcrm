const form = document.querySelector("#loginForm");
const button = document.querySelector("#loginButton");
const errorBox = document.querySelector("#loginError");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.querySelector("span").textContent = "Перевіряємо…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.email.value.trim(),
        password: form.password.value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      if (data.error === "rate_limited") throw new Error("Забагато спроб. Зачекайте 15 хвилин і спробуйте знову.");
      throw new Error("Неправильна електронна адреса або пароль.");
    }
    window.location.replace("/app");
  } catch (error) {
    errorBox.textContent = error.message || "Не вдалося увійти. Спробуйте ще раз.";
    errorBox.hidden = false;
    button.disabled = false;
    button.querySelector("span").textContent = "Увійти";
  }
});
