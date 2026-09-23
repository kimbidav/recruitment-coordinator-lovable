document.getElementById("go").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://ashbypipeline.lovable.app/onboarding?step=ashby" });
});
