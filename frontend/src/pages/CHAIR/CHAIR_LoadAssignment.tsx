import OM_LoadAssignment from "../OM/OM_LoadAssignment";

/**
 * CHAIR mirror of OM_LoadAssignment.
 * - Same UI/data/actions.
 * - CHAIR-only difference: hides "Forward to Chair" button/workflow.
 */
export default function CHAIR_LoadAssignment() {
  return <OM_LoadAssignment embedded hideForwardToChair showToPlantilla/>;
}
