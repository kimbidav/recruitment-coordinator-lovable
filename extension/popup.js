document.getElementById("go").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://candidate-compass.lovable.app/onboarding?step=ashby" });
});
