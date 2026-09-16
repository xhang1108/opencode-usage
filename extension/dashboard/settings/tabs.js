// extension/dashboard/settings/tabs.js
// Settings modal shell: open/close, tab switching, Escape/overlay handling.
// Page rendering is delegated to the caller via `renderPage(tabId, pane)`.

export function createSettingsModal({ renderPage }) {
  const modal = document.getElementById("settingsModal");
  const tabs = Array.from(modal.querySelectorAll(".settings-tab"));
  let active = "general";

  function select(tab) {
    active = tab;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    modal.querySelectorAll(".settings-pane").forEach((p) => {
      p.hidden = p.id !== `settings-${tab}`;
    });
    renderPage(tab);
  }

  function open(tab) {
    modal.style.display = "flex";
    document.body.style.overflow = "hidden";
    select(tab || active);
  }

  function close() {
    modal.style.display = "none";
    document.body.style.overflow = "";
  }

  const isOpen = () => modal.style.display !== "none";

  tabs.forEach((t) => t.addEventListener("click", () => select(t.dataset.tab)));
  document.getElementById("settingsClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  return { open, close, isOpen, select, getActive: () => active };
}
