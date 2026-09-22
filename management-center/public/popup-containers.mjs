// Keep Ant Design floating content in the document body so it cannot be
// clipped by table, card, or drawer content containers.
export function getBodyPopupContainer(triggerNode) {
  return triggerNode?.ownerDocument?.body || document.body
}
