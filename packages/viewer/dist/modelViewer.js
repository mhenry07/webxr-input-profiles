import { Object3D, Quaternion, SphereGeometry, MeshBasicMaterial, Mesh, PerspectiveCamera, Scene, Color, WebGLRenderer, DirectionalLight } from './three/build/three.module.js';
import { OrbitControls } from './three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from './three/examples/jsm/webxr/VRButton.js';
import { GLTFLoader } from './three/examples/jsm/loaders/GLTFLoader.js';
import { Constants as Constants$1, fetchProfilesList, fetchProfile, MotionController } from './motion-controllers.module.js';
import './ajv/ajv.min.js';
import validateRegistryProfile from './registryTools/validateRegistryProfile.js';
import expandRegistryProfile from './assetTools/expandRegistryProfile.js';
import buildAssetProfile from './assetTools/buildAssetProfile.js';

let motionController;
let mockGamepad;
let controlsListElement;

function updateText() {
  if (motionController) {
    Object.values(motionController.components).forEach((component) => {
      const dataElement = document.getElementById(`${component.id}_data`);
      dataElement.innerHTML = JSON.stringify(component.data, null, 2);
    });
  }
}

function onButtonValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.buttons[index].value = Number(event.target.value);
}

function onAxisValueChange(event) {
  const { index } = event.target.dataset;
  mockGamepad.axes[index] = Number(event.target.value);
}

function clear() {
  motionController = undefined;
  mockGamepad = undefined;

  if (!controlsListElement) {
    controlsListElement = document.getElementById('controlsList');
  }
  controlsListElement.innerHTML = '';
}

function addButtonControls(componentControlsElement, buttonIndex) {
  const buttonControlsElement = document.createElement('div');
  buttonControlsElement.setAttribute('class', 'componentControls');

  buttonControlsElement.innerHTML += `
  <label>buttonValue</label>
  <input id="buttons[${buttonIndex}].value" data-index="${buttonIndex}" type="range" min="0" max="1" step="0.01" value="0">
  `;

  componentControlsElement.appendChild(buttonControlsElement);

  document.getElementById(`buttons[${buttonIndex}].value`).addEventListener('input', onButtonValueChange);
}

function addAxisControls(componentControlsElement, axisName, axisIndex) {
  const axisControlsElement = document.createElement('div');
  axisControlsElement.setAttribute('class', 'componentControls');

  axisControlsElement.innerHTML += `
  <label>${axisName}<label>
  <input id="axes[${axisIndex}]" data-index="${axisIndex}"
          type="range" min="-1" max="1" step="0.01" value="0">
  `;

  componentControlsElement.appendChild(axisControlsElement);

  document.getElementById(`axes[${axisIndex}]`).addEventListener('input', onAxisValueChange);
}

function build(sourceMotionController) {
  clear();

  motionController = sourceMotionController;
  mockGamepad = motionController.xrInputSource.gamepad;

  Object.values(motionController.components).forEach((component) => {
    const componentControlsElement = document.createElement('li');
    componentControlsElement.setAttribute('class', 'component');
    controlsListElement.appendChild(componentControlsElement);

    const headingElement = document.createElement('h4');
    headingElement.innerText = `${component.id}`;
    componentControlsElement.appendChild(headingElement);

    if (component.gamepadIndices.button !== undefined) {
      addButtonControls(componentControlsElement, component.gamepadIndices.button);
    }

    if (component.gamepadIndices.xAxis !== undefined) {
      addAxisControls(componentControlsElement, 'xAxis', component.gamepadIndices.xAxis);
    }

    if (component.gamepadIndices.yAxis !== undefined) {
      addAxisControls(componentControlsElement, 'yAxis', component.gamepadIndices.yAxis);
    }

    const dataElement = document.createElement('pre');
    dataElement.id = `${component.id}_data`;
    componentControlsElement.appendChild(dataElement);
  });
}

var ManualControls = { clear, build, updateText };

let errorsSectionElement;
let errorsListElement;
class AssetError extends Error {
  constructor(...params) {
    super(...params);
    AssetError.log(this.message);
  }

  static initialize() {
    errorsListElement = document.getElementById('errors');
    errorsSectionElement = document.getElementById('errors');
  }

  static log(errorMessage) {
    const itemElement = document.createElement('li');
    itemElement.innerText = errorMessage;
    errorsListElement.appendChild(itemElement);
    errorsSectionElement.hidden = false;
  }

  static clearAll() {
    errorsListElement.innerHTML = '';
    errorsSectionElement.hidden = true;
  }
}

/* eslint-disable import/no-unresolved */

const gltfLoader = new GLTFLoader();

class ControllerModel extends Object3D {
  constructor() {
    super();
    this.xrInputSource = null;
    this.motionController = null;
    this.asset = null;
    this.rootNode = null;
    this.nodes = {};
    this.loaded = false;
  }

  async initialize(motionController) {
    this.motionController = motionController;
    this.xrInputSource = this.motionController.xrInputSource;

    // Fetch the assets and generate threejs objects for it
    this.asset = await new Promise(((resolve, reject) => {
      gltfLoader.load(
        motionController.assetUrl,
        (loadedAsset) => { resolve(loadedAsset); },
        null,
        () => { reject(new AssetError(`Asset ${motionController.assetUrl} missing or malformed.`)); }
      );
    }));

    this.rootNode = this.asset.scene;
    this.addTouchDots();
    this.findNodes();
    this.add(this.rootNode);
    this.loaded = true;
  }

  /**
   * Polls data from the XRInputSource and updates the model's components to match
   * the real world data
   */
  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);

    if (!this.loaded) {
      return;
    }

    // Cause the MotionController to poll the Gamepad for data
    this.motionController.updateFromGamepad();

    // Update the 3D model to reflect the button, thumbstick, and touchpad state
    Object.values(this.motionController.components).forEach((component) => {
      // Update node data based on the visual responses' current states
      Object.values(component.visualResponses).forEach((visualResponse) => {
        const {
          valueNodeName, minNodeName, maxNodeName, value, valueNodeProperty
        } = visualResponse;
        const valueNode = this.nodes[valueNodeName];

        // Skip if the visual response node is not found. No error is needed,
        // because it will have been reported at load time.
        if (!valueNode) return;

        // Calculate the new properties based on the weight supplied
        if (valueNodeProperty === Constants$1.VisualResponseProperty.VISIBILITY) {
          valueNode.visible = value;
        } else if (valueNodeProperty === Constants$1.VisualResponseProperty.TRANSFORM) {
          const minNode = this.nodes[minNodeName];
          const maxNode = this.nodes[maxNodeName];
          Quaternion.slerp(
            minNode.quaternion,
            maxNode.quaternion,
            valueNode.quaternion,
            value
          );

          valueNode.position.lerpVectors(
            minNode.position,
            maxNode.position,
            value
          );
        }
      });
    });
  }

  /**
   * Walks the model's tree to find the nodes needed to animate the components and
   * saves them for use in the frame loop
   */
  findNodes() {
    this.nodes = {};

    // Loop through the components and find the nodes needed for each components' visual responses
    Object.values(this.motionController.components).forEach((component) => {
      const { touchPointNodeName, visualResponses } = component;
      if (touchPointNodeName) {
        this.nodes[touchPointNodeName] = this.rootNode.getObjectByName(touchPointNodeName);
      }

      // Loop through all the visual responses to be applied to this component
      Object.values(visualResponses).forEach((visualResponse) => {
        const {
          valueNodeName, minNodeName, maxNodeName, valueNodeProperty
        } = visualResponse;
        // If animating a transform, find the two nodes to be interpolated between.
        if (valueNodeProperty === Constants$1.VisualResponseProperty.TRANSFORM) {
          this.nodes[minNodeName] = this.rootNode.getObjectByName(minNodeName);
          this.nodes[maxNodeName] = this.rootNode.getObjectByName(maxNodeName);

          // If the extents cannot be found, skip this animation
          if (!this.nodes[minNodeName]) {
            AssetError.log(`Could not find ${minNodeName} in the model`);
            return;
          }
          if (!this.nodes[maxNodeName]) {
            AssetError.log(`Could not find ${maxNodeName} in the model`);
            return;
          }
        }

        // If the target node cannot be found, skip this animation
        this.nodes[valueNodeName] = this.rootNode.getObjectByName(valueNodeName);
        if (!this.nodes[valueNodeName]) {
          AssetError.log(`Could not find ${valueNodeName} in the model`);
        }
      });
    });
  }

  /**
   * Add touch dots to all touchpad components so the finger can be seen
   */
  addTouchDots() {
    Object.keys(this.motionController.components).forEach((componentId) => {
      const component = this.motionController.components[componentId];
      // Find the touchpads
      if (component.type === Constants$1.ComponentType.TOUCHPAD) {
        // Find the node to attach the touch dot.
        const touchPointRoot = this.rootNode.getObjectByName(component.touchPointNodeName, true);
        if (!touchPointRoot) {
          AssetError.log(`Could not find touch dot, ${component.touchPointNodeName}, in touchpad component ${componentId}`);
        } else {
          const sphereGeometry = new SphereGeometry(0.001);
          const material = new MeshBasicMaterial({ color: 0x0000FF });
          const sphere = new Mesh(sphereGeometry, material);
          touchPointRoot.add(sphere);
        }
      }
    });
  }
}

/* eslint-disable import/no-unresolved */

/**
 * Loads a profile from a set of local files
 */
class LocalProfile extends EventTarget {
  constructor() {
    super();

    this.localFilesListElement = document.getElementById('localFilesList');
    this.filesSelector = document.getElementById('localFilesSelector');
    this.filesSelector.addEventListener('change', () => {
      this.onFilesSelected();
    });

    this.clear();

    LocalProfile.buildSchemaValidator('registryTools/registrySchemas.json').then((registrySchemaValidator) => {
      this.registrySchemaValidator = registrySchemaValidator;
      LocalProfile.buildSchemaValidator('assetTools/assetSchemas.json').then((assetSchemaValidator) => {
        this.assetSchemaValidator = assetSchemaValidator;
        const duringPageLoad = true;
        this.onFilesSelected(duringPageLoad);
      });
    });
  }

  /**
   * Clears all local profile information
   */
  clear() {
    if (this.profile) {
      this.profile = null;
      this.profileId = null;
      this.assets = [];
      this.localFilesListElement.innerHTML = '';

      const changeEvent = new Event('localProfileChange');
      this.dispatchEvent(changeEvent);
    }
  }

  /**
   * Processes selected files and generates an asset profile
   * @param {boolean} duringPageLoad
   */
  async onFilesSelected(duringPageLoad) {
    this.clear();

    // Skip if initialzation is incomplete
    if (!this.assetSchemaValidator) {
      return;
    }

    // Examine the files selected to find the registry profile, asset overrides, and asset files
    const assets = [];
    let assetJsonFile;
    let registryJsonFile;

    const filesList = Array.from(this.filesSelector.files);
    filesList.forEach((file) => {
      if (file.name.endsWith('.glb')) {
        assets[file.name] = window.URL.createObjectURL(file);
      } else if (file.name === 'profile.json') {
        assetJsonFile = file;
      } else if (file.name.endsWith('.json')) {
        registryJsonFile = file;
      }

      // List the files found
      this.localFilesListElement.innerHTML += `
        <li>${file.name}</li>
      `;
    });

    if (!registryJsonFile) {
      AssetError.log('No registry profile selected');
      return;
    }

    await this.buildProfile(registryJsonFile, assetJsonFile, assets);
    this.assets = assets;

    // Change the selected profile to the one just loaded.  Do not do this on initial page load
    // because the selected files persists in firefox across refreshes, but the user may have
    // selected a different item from the dropdown
    if (!duringPageLoad) {
      window.localStorage.setItem('profileId', this.profileId);
    }

    // Notify that the local profile is ready for use
    const changeEvent = new Event('localprofilechange');
    this.dispatchEvent(changeEvent);
  }

  /**
   * Build a merged profile file from the registry profile and asset overrides
   * @param {*} registryJsonFile
   * @param {*} assetJsonFile
   */
  async buildProfile(registryJsonFile, assetJsonFile) {
    // Load the registry JSON and validate it against the schema
    const registryJson = await LocalProfile.loadLocalJson(registryJsonFile);
    const isRegistryJsonValid = this.registrySchemaValidator(registryJson);
    if (!isRegistryJsonValid) {
      throw new AssetError(JSON.stringify(this.registrySchemaValidator.errors, null, 2));
    }

    // Load the asset JSON and validate it against the schema.
    // If no asset JSON present, use the default definiton
    let assetJson;
    if (!assetJsonFile) {
      assetJson = { profileId: registryJson.profileId, overrides: {} };
    } else {
      assetJson = await LocalProfile.loadLocalJson(assetJsonFile);
      const isAssetJsonValid = this.assetSchemaValidator(assetJson);
      if (!isAssetJsonValid) {
        throw new AssetError(JSON.stringify(this.assetSchemaValidator.errors, null, 2));
      }
    }

    // Validate non-schema requirements and build a combined profile
    validateRegistryProfile(registryJson);
    const expandedRegistryProfile = expandRegistryProfile(registryJson);
    this.profile = buildAssetProfile(assetJson, expandedRegistryProfile);
    this.profileId = this.profile.profileId;
  }

  /**
   * Helper to load JSON from a local file
   * @param {File} jsonFile
   */
  static loadLocalJson(jsonFile) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const json = JSON.parse(reader.result);
        resolve(json);
      };

      reader.onerror = () => {
        const errorMessage = `Unable to load JSON from ${jsonFile.name}`;
        AssetError.log(errorMessage);
        reject(errorMessage);
      };

      reader.readAsText(jsonFile);
    });
  }

  /**
   * Helper to load the combined schema file and compile an AJV validator
   * @param {string} schemasPath
   */
  static async buildSchemaValidator(schemasPath) {
    const response = await fetch(schemasPath);
    if (!response.ok) {
      throw new AssetError(response.statusText);
    }

    // eslint-disable-next-line no-undef
    const ajv = new Ajv();
    const schemas = await response.json();
    schemas.dependencies.forEach((schema) => {
      ajv.addSchema(schema);
    });

    return ajv.compile(schemas.mainSchema);
  }
}

/* eslint-disable import/no-unresolved */

const profilesBasePath = './profiles';

/**
 * Loads profiles from the distribution folder next to the viewer's location
 */
class ProfileSelector extends EventTarget {
  constructor() {
    super();

    // Get the profile id selector and listen for changes
    this.profileIdSelectorElement = document.getElementById('profileIdSelector');
    this.profileIdSelectorElement.addEventListener('change', () => { this.onProfileIdChange(); });

    // Get the handedness selector and listen for changes
    this.handednessSelectorElement = document.getElementById('handednessSelector');
    this.handednessSelectorElement.addEventListener('change', () => { this.onHandednessChange(); });

    this.localProfile = new LocalProfile();
    this.localProfile.addEventListener('localprofilechange', (event) => { this.onLocalProfileChange(event); });

    this.profilesList = null;
    this.populateProfileSelector();
  }

  /**
   * Resets all selected profile state
   */
  clearSelectedProfile() {
    AssetError.clearAll();
    this.profile = null;
    this.handedness = null;
  }

  /**
   * Retrieves the full list of available profiles and populates the dropdown
   */
  async populateProfileSelector() {
    this.clearSelectedProfile();
    this.handednessSelectorElement.innerHTML = '';

    // Load and clear local storage
    const storedProfileId = window.localStorage.getItem('profileId');
    window.localStorage.removeItem('profileId');

    // Load the list of profiles
    if (!this.profilesList) {
      try {
        this.profileIdSelectorElement.innerHTML = '<option value="loading">Loading...</option>';
        this.profilesList = await fetchProfilesList(profilesBasePath);
      } catch (error) {
        this.profileIdSelectorElement.innerHTML = 'Failed to load list';
        AssetError.log(error.message);
        throw error;
      }
    }

    // Add each profile to the dropdown
    this.profileIdSelectorElement.innerHTML = '';
    Object.keys(this.profilesList).forEach((profileId) => {
      this.profileIdSelectorElement.innerHTML += `
      <option value='${profileId}'>${profileId}</option>
      `;
    });

    // Add the local profile if it isn't already included
    if (this.localProfile.profileId
     && !Object.keys(this.profilesList).includes(this.localProfile.profileId)) {
      this.profileIdSelectorElement.innerHTML += `
      <option value='${this.localProfile.profileId}'>${this.localProfile.profileId}</option>
      `;
    }

    // Override the default selection if values were present in local storage
    if (storedProfileId) {
      this.profileIdSelectorElement.value = storedProfileId;
    }

    // Manually trigger selected profile to load
    this.onProfileIdChange();
  }

  /**
   * Handler for the profile id selection change
   */
  onProfileIdChange() {
    this.clearSelectedProfile();
    this.handednessSelectorElement.innerHTML = '';

    const profileId = this.profileIdSelectorElement.value;
    window.localStorage.setItem('profileId', profileId);

    if (profileId === this.localProfile.profileId) {
      this.profile = this.localProfile.profile;
      this.populateHandednessSelector();
    } else {
      // Attempt to load the profile
      this.profileIdSelectorElement.disabled = true;
      this.handednessSelectorElement.disabled = true;
      fetchProfile({ profiles: [profileId] }, profilesBasePath, false).then(({ profile }) => {
        this.profile = profile;
        this.populateHandednessSelector();
      })
        .catch((error) => {
          AssetError.log(error.message);
          throw error;
        })
        .finally(() => {
          this.profileIdSelectorElement.disabled = false;
          this.handednessSelectorElement.disabled = false;
        });
    }
  }

  /**
   * Populates the handedness dropdown with those supported by the selected profile
   */
  populateHandednessSelector() {
    // Load and clear the last selection for this profile id
    const storedHandedness = window.localStorage.getItem('handedness');
    window.localStorage.removeItem('handedness');

    // Populate handedness selector
    Object.keys(this.profile.layouts).forEach((handedness) => {
      this.handednessSelectorElement.innerHTML += `
        <option value='${handedness}'>${handedness}</option>
      `;
    });

    // Apply stored handedness if found
    if (storedHandedness && this.profile.layouts[storedHandedness]) {
      this.handednessSelectorElement.value = storedHandedness;
    }

    // Manually trigger selected handedness change
    this.onHandednessChange();
  }

  /**
   * Responds to changes in selected handedness.
   * Creates a new motion controller for the combination of profile and handedness, and fires an
   * event to signal the change
   */
  onHandednessChange() {
    AssetError.clearAll();
    this.handedness = this.handednessSelectorElement.value;
    window.localStorage.setItem('handedness', this.handedness);
    if (this.handedness) {
      this.dispatchEvent(new Event('selectionchange'));
    } else {
      this.dispatchEvent(new Event('selectionclear'));
    }
  }

  /**
   * Updates the profiles dropdown to ensure local profile is in the list
   */
  onLocalProfileChange() {
    this.populateProfileSelector();
  }

  /**
   * Builds a MotionController either based on the supplied input source using the local profile
   * if it is the best match, otherwise uses the remote assets
   * @param {XRInputSource} xrInputSource
   */
  async createMotionController(xrInputSource) {
    let profile;
    let assetPath;

    // Check if local override should be used
    let useLocalProfile = false;
    if (this.localProfile.profileId) {
      xrInputSource.profiles.some((profileId) => {
        const matchFound = Object.keys(this.profilesList).includes(profileId);
        useLocalProfile = matchFound && (profileId === this.localProfile.profileId);
        return matchFound;
      });
    }

    // Get profile and asset path
    if (useLocalProfile) {
      ({ profile } = this.localProfile);
      const assetName = this.localProfile.profile.layouts[xrInputSource.handedness].assetPath;
      assetPath = this.localProfile.assets[assetName] || assetName;
    } else {
      ({ profile, assetPath } = await fetchProfile(xrInputSource, profilesBasePath));
    }

    // Build motion controller
    const motionController = new MotionController(
      xrInputSource,
      profile,
      assetPath
    );

    return motionController;
  }
}

const Constants = {
  Handedness: Object.freeze({
    NONE: 'none',
    LEFT: 'left',
    RIGHT: 'right'
  }),

  ComponentState: Object.freeze({
    DEFAULT: 'default',
    TOUCHED: 'touched',
    PRESSED: 'pressed'
  }),

  ComponentProperty: Object.freeze({
    BUTTON: 'button',
    X_AXIS: 'xAxis',
    Y_AXIS: 'yAxis',
    STATE: 'state'
  }),

  ComponentType: Object.freeze({
    TRIGGER: 'trigger',
    SQUEEZE: 'squeeze',
    TOUCHPAD: 'touchpad',
    THUMBSTICK: 'thumbstick',
    BUTTON: 'button'
  }),

  ButtonTouchThreshold: 0.05,

  AxisTouchThreshold: 0.1,

  VisualResponseProperty: Object.freeze({
    TRANSFORM: 'transform',
    VISIBILITY: 'visibility'
  })
};

/**
 * A false gamepad to be used in tests
 */
class MockGamepad {
  /**
   * @param {Object} profileDescription - The profile description to parse to determine the length
   * of the button and axes arrays
   * @param {string} handedness - The gamepad's handedness
   */
  constructor(profileDescription, handedness) {
    if (!profileDescription) {
      throw new Error('No profileDescription supplied');
    }

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.id = profileDescription.profileId;

    // Loop through the profile description to determine how many elements to put in the buttons
    // and axes arrays
    let maxButtonIndex = 0;
    let maxAxisIndex = 0;
    const layout = profileDescription.layouts[handedness];
    this.mapping = layout.mapping;
    Object.values(layout.components).forEach(({ gamepadIndices }) => {
      const {
        [Constants.ComponentProperty.BUTTON]: buttonIndex,
        [Constants.ComponentProperty.X_AXIS]: xAxisIndex,
        [Constants.ComponentProperty.Y_AXIS]: yAxisIndex
      } = gamepadIndices;

      if (buttonIndex !== undefined && buttonIndex > maxButtonIndex) {
        maxButtonIndex = buttonIndex;
      }

      if (xAxisIndex !== undefined && (xAxisIndex > maxAxisIndex)) {
        maxAxisIndex = xAxisIndex;
      }

      if (yAxisIndex !== undefined && (yAxisIndex > maxAxisIndex)) {
        maxAxisIndex = yAxisIndex;
      }
    });

    // Fill the axes array
    this.axes = [];
    while (this.axes.length <= maxAxisIndex) {
      this.axes.push(0);
    }

    // Fill the buttons array
    this.buttons = [];
    while (this.buttons.length <= maxButtonIndex) {
      this.buttons.push({
        value: 0,
        touched: false,
        pressed: false
      });
    }
  }
}

/**
 * A fake XRInputSource that can be used to initialize a MotionController
 */
class MockXRInputSource {
  /**
   * @param {Object} gamepad - The Gamepad object that provides the button and axis data
   * @param {string} handedness - The handedness to report
   */
  constructor(gamepad, handedness) {
    this.gamepad = gamepad;

    if (!handedness) {
      throw new Error('No handedness supplied');
    }

    this.handedness = handedness;
    this.profiles = Object.freeze([this.gamepad.id]);
  }
}

/* eslint-disable import/no-unresolved */

const three = {};
let canvasParentElement;

let profileSelector;
let mockControllerModel;
let isImmersive = false;

/**
 * Adds the event handlers for VR motion controllers to load the assets on connection
 * and remove them on disconnection
 * @param {number} index
 */
function initializeVRController(index) {
  const vrController = three.renderer.xr.getController(index);

  vrController.addEventListener('connected', async (event) => {
    const controllerModel = new ControllerModel();
    vrController.add(controllerModel);

    const motionController = await profileSelector.createMotionController(event.data);
    await controllerModel.initialize(motionController);
  });

  vrController.addEventListener('disconnected', () => {
    vrController.remove(vrController.children[0]);
  });

  three.scene.add(vrController);
}

/**
 * The three.js render loop (used instead of requestAnimationFrame to support XR)
 */
function render() {
  if (mockControllerModel) {
    if (isImmersive) {
      three.scene.remove(mockControllerModel);
    } else {
      three.scene.add(mockControllerModel);
      ManualControls.updateText();
    }
  }

  three.cameraControls.update();

  three.renderer.render(three.scene, three.camera);
}

/**
 * @description Event handler for window resizing.
 */
function onResize() {
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;
  three.camera.aspectRatio = width / height;
  three.camera.updateProjectionMatrix();
  three.renderer.setSize(width, height);
  three.cameraControls.update();
}

/**
 * Initializes the three.js resources needed for this page
 */
function initializeThree() {
  canvasParentElement = document.getElementById('modelViewer');
  const width = canvasParentElement.clientWidth;
  const height = canvasParentElement.clientHeight;

  // Set up the THREE.js infrastructure
  three.camera = new PerspectiveCamera(75, width / height, 0.01, 1000);
  three.camera.position.y = 0.5;
  three.scene = new Scene();
  three.scene.background = new Color(0x00aa44);
  three.renderer = new WebGLRenderer({ antialias: true });
  three.renderer.setSize(width, height);
  three.renderer.gammaOutput = true;

  // Set up the controls for moving the scene around
  three.cameraControls = new OrbitControls(three.camera, three.renderer.domElement);
  three.cameraControls.enableDamping = true;
  three.cameraControls.minDistance = 0.05;
  three.cameraControls.maxDistance = 0.3;
  three.cameraControls.enablePan = false;
  three.cameraControls.update();

  // Set up the lights so the model can be seen
  const bottomDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
  bottomDirectionalLight.position.set(0, -1, 0);
  three.scene.add(bottomDirectionalLight);
  const topDirectionalLight = new DirectionalLight(0xFFFFFF, 2);
  three.scene.add(topDirectionalLight);

  // Add VR
  canvasParentElement.appendChild(VRButton.createButton(three.renderer));
  three.renderer.xr.enabled = true;
  three.renderer.xr.addEventListener('sessionstart', () => { isImmersive = true; });
  three.renderer.xr.addEventListener('sessionend', () => { isImmersive = false; });
  initializeVRController(0);
  initializeVRController(1);

  // Add the THREE.js canvas to the page
  canvasParentElement.appendChild(three.renderer.domElement);
  window.addEventListener('resize', onResize, false);

  // Start pumping frames
  three.renderer.setAnimationLoop(render);
}

function onSelectionClear() {
  ManualControls.clear();
  if (mockControllerModel) {
    three.scene.remove(mockControllerModel);
    mockControllerModel = null;
  }
}

async function onSelectionChange() {
  onSelectionClear();
  const mockGamepad = new MockGamepad(profileSelector.profile, profileSelector.handedness);
  const mockXRInputSource = new MockXRInputSource(mockGamepad, profileSelector.handedness);
  mockControllerModel = new ControllerModel(mockXRInputSource);
  three.scene.add(mockControllerModel);

  const motionController = await profileSelector.createMotionController(mockXRInputSource);
  ManualControls.build(motionController);
  await mockControllerModel.initialize(motionController);
}

/**
 * Page load handler for initialzing things that depend on the DOM to be ready
 */
function onLoad() {
  AssetError.initialize();
  profileSelector = new ProfileSelector();
  initializeThree();

  profileSelector.addEventListener('selectionclear', onSelectionClear);
  profileSelector.addEventListener('selectionchange', onSelectionChange);
}
window.addEventListener('load', onLoad);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9kZWxWaWV3ZXIuanMiLCJzb3VyY2VzIjpbIi4uL3NyYy9tYW51YWxDb250cm9scy5qcyIsIi4uL3NyYy9hc3NldEVycm9yLmpzIiwiLi4vc3JjL2NvbnRyb2xsZXJNb2RlbC5qcyIsIi4uL3NyYy9sb2NhbFByb2ZpbGUuanMiLCIuLi9zcmMvcHJvZmlsZVNlbGVjdG9yLmpzIiwiLi4vLi4vbW90aW9uLWNvbnRyb2xsZXJzL3NyYy9jb25zdGFudHMuanMiLCIuLi9zcmMvbW9ja3MvbW9ja0dhbWVwYWQuanMiLCIuLi9zcmMvbW9ja3MvbW9ja1hSSW5wdXRTb3VyY2UuanMiLCIuLi9zcmMvbW9kZWxWaWV3ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsibGV0IG1vdGlvbkNvbnRyb2xsZXI7XG5sZXQgbW9ja0dhbWVwYWQ7XG5sZXQgY29udHJvbHNMaXN0RWxlbWVudDtcblxuZnVuY3Rpb24gdXBkYXRlVGV4dCgpIHtcbiAgaWYgKG1vdGlvbkNvbnRyb2xsZXIpIHtcbiAgICBPYmplY3QudmFsdWVzKG1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XG4gICAgICBjb25zdCBkYXRhRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGAke2NvbXBvbmVudC5pZH1fZGF0YWApO1xuICAgICAgZGF0YUVsZW1lbnQuaW5uZXJIVE1MID0gSlNPTi5zdHJpbmdpZnkoY29tcG9uZW50LmRhdGEsIG51bGwsIDIpO1xuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIG9uQnV0dG9uVmFsdWVDaGFuZ2UoZXZlbnQpIHtcbiAgY29uc3QgeyBpbmRleCB9ID0gZXZlbnQudGFyZ2V0LmRhdGFzZXQ7XG4gIG1vY2tHYW1lcGFkLmJ1dHRvbnNbaW5kZXhdLnZhbHVlID0gTnVtYmVyKGV2ZW50LnRhcmdldC52YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG9uQXhpc1ZhbHVlQ2hhbmdlKGV2ZW50KSB7XG4gIGNvbnN0IHsgaW5kZXggfSA9IGV2ZW50LnRhcmdldC5kYXRhc2V0O1xuICBtb2NrR2FtZXBhZC5heGVzW2luZGV4XSA9IE51bWJlcihldmVudC50YXJnZXQudmFsdWUpO1xufVxuXG5mdW5jdGlvbiBjbGVhcigpIHtcbiAgbW90aW9uQ29udHJvbGxlciA9IHVuZGVmaW5lZDtcbiAgbW9ja0dhbWVwYWQgPSB1bmRlZmluZWQ7XG5cbiAgaWYgKCFjb250cm9sc0xpc3RFbGVtZW50KSB7XG4gICAgY29udHJvbHNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb250cm9sc0xpc3QnKTtcbiAgfVxuICBjb250cm9sc0xpc3RFbGVtZW50LmlubmVySFRNTCA9ICcnO1xufVxuXG5mdW5jdGlvbiBhZGRCdXR0b25Db250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsIGJ1dHRvbkluZGV4KSB7XG4gIGNvbnN0IGJ1dHRvbkNvbnRyb2xzRWxlbWVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBidXR0b25Db250cm9sc0VsZW1lbnQuc2V0QXR0cmlidXRlKCdjbGFzcycsICdjb21wb25lbnRDb250cm9scycpO1xuXG4gIGJ1dHRvbkNvbnRyb2xzRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICA8bGFiZWw+YnV0dG9uVmFsdWU8L2xhYmVsPlxuICA8aW5wdXQgaWQ9XCJidXR0b25zWyR7YnV0dG9uSW5kZXh9XS52YWx1ZVwiIGRhdGEtaW5kZXg9XCIke2J1dHRvbkluZGV4fVwiIHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxXCIgc3RlcD1cIjAuMDFcIiB2YWx1ZT1cIjBcIj5cbiAgYDtcblxuICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuYXBwZW5kQ2hpbGQoYnV0dG9uQ29udHJvbHNFbGVtZW50KTtcblxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgYnV0dG9uc1ske2J1dHRvbkluZGV4fV0udmFsdWVgKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIG9uQnV0dG9uVmFsdWVDaGFuZ2UpO1xufVxuXG5mdW5jdGlvbiBhZGRBeGlzQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCBheGlzTmFtZSwgYXhpc0luZGV4KSB7XG4gIGNvbnN0IGF4aXNDb250cm9sc0VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgYXhpc0NvbnRyb2xzRWxlbWVudC5zZXRBdHRyaWJ1dGUoJ2NsYXNzJywgJ2NvbXBvbmVudENvbnRyb2xzJyk7XG5cbiAgYXhpc0NvbnRyb2xzRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICA8bGFiZWw+JHtheGlzTmFtZX08bGFiZWw+XG4gIDxpbnB1dCBpZD1cImF4ZXNbJHtheGlzSW5kZXh9XVwiIGRhdGEtaW5kZXg9XCIke2F4aXNJbmRleH1cIlxuICAgICAgICAgIHR5cGU9XCJyYW5nZVwiIG1pbj1cIi0xXCIgbWF4PVwiMVwiIHN0ZXA9XCIwLjAxXCIgdmFsdWU9XCIwXCI+XG4gIGA7XG5cbiAgY29tcG9uZW50Q29udHJvbHNFbGVtZW50LmFwcGVuZENoaWxkKGF4aXNDb250cm9sc0VsZW1lbnQpO1xuXG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBheGVzWyR7YXhpc0luZGV4fV1gKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIG9uQXhpc1ZhbHVlQ2hhbmdlKTtcbn1cblxuZnVuY3Rpb24gYnVpbGQoc291cmNlTW90aW9uQ29udHJvbGxlcikge1xuICBjbGVhcigpO1xuXG4gIG1vdGlvbkNvbnRyb2xsZXIgPSBzb3VyY2VNb3Rpb25Db250cm9sbGVyO1xuICBtb2NrR2FtZXBhZCA9IG1vdGlvbkNvbnRyb2xsZXIueHJJbnB1dFNvdXJjZS5nYW1lcGFkO1xuXG4gIE9iamVjdC52YWx1ZXMobW90aW9uQ29udHJvbGxlci5jb21wb25lbnRzKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcbiAgICBjb25zdCBjb21wb25lbnRDb250cm9sc0VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsaScpO1xuICAgIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5zZXRBdHRyaWJ1dGUoJ2NsYXNzJywgJ2NvbXBvbmVudCcpO1xuICAgIGNvbnRyb2xzTGlzdEVsZW1lbnQuYXBwZW5kQ2hpbGQoY29tcG9uZW50Q29udHJvbHNFbGVtZW50KTtcblxuICAgIGNvbnN0IGhlYWRpbmdFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaDQnKTtcbiAgICBoZWFkaW5nRWxlbWVudC5pbm5lclRleHQgPSBgJHtjb21wb25lbnQuaWR9YDtcbiAgICBjb21wb25lbnRDb250cm9sc0VsZW1lbnQuYXBwZW5kQ2hpbGQoaGVhZGluZ0VsZW1lbnQpO1xuXG4gICAgaWYgKGNvbXBvbmVudC5nYW1lcGFkSW5kaWNlcy5idXR0b24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgYWRkQnV0dG9uQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCBjb21wb25lbnQuZ2FtZXBhZEluZGljZXMuYnV0dG9uKTtcbiAgICB9XG5cbiAgICBpZiAoY29tcG9uZW50LmdhbWVwYWRJbmRpY2VzLnhBeGlzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGFkZEF4aXNDb250cm9scyhjb21wb25lbnRDb250cm9sc0VsZW1lbnQsICd4QXhpcycsIGNvbXBvbmVudC5nYW1lcGFkSW5kaWNlcy54QXhpcyk7XG4gICAgfVxuXG4gICAgaWYgKGNvbXBvbmVudC5nYW1lcGFkSW5kaWNlcy55QXhpcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBhZGRBeGlzQ29udHJvbHMoY29tcG9uZW50Q29udHJvbHNFbGVtZW50LCAneUF4aXMnLCBjb21wb25lbnQuZ2FtZXBhZEluZGljZXMueUF4aXMpO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGFFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncHJlJyk7XG4gICAgZGF0YUVsZW1lbnQuaWQgPSBgJHtjb21wb25lbnQuaWR9X2RhdGFgO1xuICAgIGNvbXBvbmVudENvbnRyb2xzRWxlbWVudC5hcHBlbmRDaGlsZChkYXRhRWxlbWVudCk7XG4gIH0pO1xufVxuXG5leHBvcnQgZGVmYXVsdCB7IGNsZWFyLCBidWlsZCwgdXBkYXRlVGV4dCB9O1xuIiwibGV0IGVycm9yc1NlY3Rpb25FbGVtZW50O1xubGV0IGVycm9yc0xpc3RFbGVtZW50O1xuY2xhc3MgQXNzZXRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoLi4ucGFyYW1zKSB7XG4gICAgc3VwZXIoLi4ucGFyYW1zKTtcbiAgICBBc3NldEVycm9yLmxvZyh0aGlzLm1lc3NhZ2UpO1xuICB9XG5cbiAgc3RhdGljIGluaXRpYWxpemUoKSB7XG4gICAgZXJyb3JzTGlzdEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3JzJyk7XG4gICAgZXJyb3JzU2VjdGlvbkVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXJyb3JzJyk7XG4gIH1cblxuICBzdGF0aWMgbG9nKGVycm9yTWVzc2FnZSkge1xuICAgIGNvbnN0IGl0ZW1FbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcbiAgICBpdGVtRWxlbWVudC5pbm5lclRleHQgPSBlcnJvck1lc3NhZ2U7XG4gICAgZXJyb3JzTGlzdEVsZW1lbnQuYXBwZW5kQ2hpbGQoaXRlbUVsZW1lbnQpO1xuICAgIGVycm9yc1NlY3Rpb25FbGVtZW50LmhpZGRlbiA9IGZhbHNlO1xuICB9XG5cbiAgc3RhdGljIGNsZWFyQWxsKCkge1xuICAgIGVycm9yc0xpc3RFbGVtZW50LmlubmVySFRNTCA9ICcnO1xuICAgIGVycm9yc1NlY3Rpb25FbGVtZW50LmhpZGRlbiA9IHRydWU7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgQXNzZXRFcnJvcjtcbiIsIi8qIGVzbGludC1kaXNhYmxlIGltcG9ydC9uby11bnJlc29sdmVkICovXG5pbXBvcnQgKiBhcyBUSFJFRSBmcm9tICcuL3RocmVlL2J1aWxkL3RocmVlLm1vZHVsZS5qcyc7XG5pbXBvcnQgeyBHTFRGTG9hZGVyIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vbG9hZGVycy9HTFRGTG9hZGVyLmpzJztcbmltcG9ydCB7IENvbnN0YW50cyB9IGZyb20gJy4vbW90aW9uLWNvbnRyb2xsZXJzLm1vZHVsZS5qcyc7XG4vKiBlc2xpbnQtZW5hYmxlICovXG5cbmltcG9ydCBBc3NldEVycm9yIGZyb20gJy4vYXNzZXRFcnJvci5qcyc7XG5cbmNvbnN0IGdsdGZMb2FkZXIgPSBuZXcgR0xURkxvYWRlcigpO1xuXG5jbGFzcyBDb250cm9sbGVyTW9kZWwgZXh0ZW5kcyBUSFJFRS5PYmplY3QzRCB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy54cklucHV0U291cmNlID0gbnVsbDtcbiAgICB0aGlzLm1vdGlvbkNvbnRyb2xsZXIgPSBudWxsO1xuICAgIHRoaXMuYXNzZXQgPSBudWxsO1xuICAgIHRoaXMucm9vdE5vZGUgPSBudWxsO1xuICAgIHRoaXMubm9kZXMgPSB7fTtcbiAgICB0aGlzLmxvYWRlZCA9IGZhbHNlO1xuICB9XG5cbiAgYXN5bmMgaW5pdGlhbGl6ZShtb3Rpb25Db250cm9sbGVyKSB7XG4gICAgdGhpcy5tb3Rpb25Db250cm9sbGVyID0gbW90aW9uQ29udHJvbGxlcjtcbiAgICB0aGlzLnhySW5wdXRTb3VyY2UgPSB0aGlzLm1vdGlvbkNvbnRyb2xsZXIueHJJbnB1dFNvdXJjZTtcblxuICAgIC8vIEZldGNoIHRoZSBhc3NldHMgYW5kIGdlbmVyYXRlIHRocmVlanMgb2JqZWN0cyBmb3IgaXRcbiAgICB0aGlzLmFzc2V0ID0gYXdhaXQgbmV3IFByb21pc2UoKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGdsdGZMb2FkZXIubG9hZChcbiAgICAgICAgbW90aW9uQ29udHJvbGxlci5hc3NldFVybCxcbiAgICAgICAgKGxvYWRlZEFzc2V0KSA9PiB7IHJlc29sdmUobG9hZGVkQXNzZXQpOyB9LFxuICAgICAgICBudWxsLFxuICAgICAgICAoKSA9PiB7IHJlamVjdChuZXcgQXNzZXRFcnJvcihgQXNzZXQgJHttb3Rpb25Db250cm9sbGVyLmFzc2V0VXJsfSBtaXNzaW5nIG9yIG1hbGZvcm1lZC5gKSk7IH1cbiAgICAgICk7XG4gICAgfSkpO1xuXG4gICAgdGhpcy5yb290Tm9kZSA9IHRoaXMuYXNzZXQuc2NlbmU7XG4gICAgdGhpcy5hZGRUb3VjaERvdHMoKTtcbiAgICB0aGlzLmZpbmROb2RlcygpO1xuICAgIHRoaXMuYWRkKHRoaXMucm9vdE5vZGUpO1xuICAgIHRoaXMubG9hZGVkID0gdHJ1ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBQb2xscyBkYXRhIGZyb20gdGhlIFhSSW5wdXRTb3VyY2UgYW5kIHVwZGF0ZXMgdGhlIG1vZGVsJ3MgY29tcG9uZW50cyB0byBtYXRjaFxuICAgKiB0aGUgcmVhbCB3b3JsZCBkYXRhXG4gICAqL1xuICB1cGRhdGVNYXRyaXhXb3JsZChmb3JjZSkge1xuICAgIHN1cGVyLnVwZGF0ZU1hdHJpeFdvcmxkKGZvcmNlKTtcblxuICAgIGlmICghdGhpcy5sb2FkZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBDYXVzZSB0aGUgTW90aW9uQ29udHJvbGxlciB0byBwb2xsIHRoZSBHYW1lcGFkIGZvciBkYXRhXG4gICAgdGhpcy5tb3Rpb25Db250cm9sbGVyLnVwZGF0ZUZyb21HYW1lcGFkKCk7XG5cbiAgICAvLyBVcGRhdGUgdGhlIDNEIG1vZGVsIHRvIHJlZmxlY3QgdGhlIGJ1dHRvbiwgdGh1bWJzdGljaywgYW5kIHRvdWNocGFkIHN0YXRlXG4gICAgT2JqZWN0LnZhbHVlcyh0aGlzLm1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50cykuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XG4gICAgICAvLyBVcGRhdGUgbm9kZSBkYXRhIGJhc2VkIG9uIHRoZSB2aXN1YWwgcmVzcG9uc2VzJyBjdXJyZW50IHN0YXRlc1xuICAgICAgT2JqZWN0LnZhbHVlcyhjb21wb25lbnQudmlzdWFsUmVzcG9uc2VzKS5mb3JFYWNoKCh2aXN1YWxSZXNwb25zZSkgPT4ge1xuICAgICAgICBjb25zdCB7XG4gICAgICAgICAgdmFsdWVOb2RlTmFtZSwgbWluTm9kZU5hbWUsIG1heE5vZGVOYW1lLCB2YWx1ZSwgdmFsdWVOb2RlUHJvcGVydHlcbiAgICAgICAgfSA9IHZpc3VhbFJlc3BvbnNlO1xuICAgICAgICBjb25zdCB2YWx1ZU5vZGUgPSB0aGlzLm5vZGVzW3ZhbHVlTm9kZU5hbWVdO1xuXG4gICAgICAgIC8vIFNraXAgaWYgdGhlIHZpc3VhbCByZXNwb25zZSBub2RlIGlzIG5vdCBmb3VuZC4gTm8gZXJyb3IgaXMgbmVlZGVkLFxuICAgICAgICAvLyBiZWNhdXNlIGl0IHdpbGwgaGF2ZSBiZWVuIHJlcG9ydGVkIGF0IGxvYWQgdGltZS5cbiAgICAgICAgaWYgKCF2YWx1ZU5vZGUpIHJldHVybjtcblxuICAgICAgICAvLyBDYWxjdWxhdGUgdGhlIG5ldyBwcm9wZXJ0aWVzIGJhc2VkIG9uIHRoZSB3ZWlnaHQgc3VwcGxpZWRcbiAgICAgICAgaWYgKHZhbHVlTm9kZVByb3BlcnR5ID09PSBDb25zdGFudHMuVmlzdWFsUmVzcG9uc2VQcm9wZXJ0eS5WSVNJQklMSVRZKSB7XG4gICAgICAgICAgdmFsdWVOb2RlLnZpc2libGUgPSB2YWx1ZTtcbiAgICAgICAgfSBlbHNlIGlmICh2YWx1ZU5vZGVQcm9wZXJ0eSA9PT0gQ29uc3RhbnRzLlZpc3VhbFJlc3BvbnNlUHJvcGVydHkuVFJBTlNGT1JNKSB7XG4gICAgICAgICAgY29uc3QgbWluTm9kZSA9IHRoaXMubm9kZXNbbWluTm9kZU5hbWVdO1xuICAgICAgICAgIGNvbnN0IG1heE5vZGUgPSB0aGlzLm5vZGVzW21heE5vZGVOYW1lXTtcbiAgICAgICAgICBUSFJFRS5RdWF0ZXJuaW9uLnNsZXJwKFxuICAgICAgICAgICAgbWluTm9kZS5xdWF0ZXJuaW9uLFxuICAgICAgICAgICAgbWF4Tm9kZS5xdWF0ZXJuaW9uLFxuICAgICAgICAgICAgdmFsdWVOb2RlLnF1YXRlcm5pb24sXG4gICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICk7XG5cbiAgICAgICAgICB2YWx1ZU5vZGUucG9zaXRpb24ubGVycFZlY3RvcnMoXG4gICAgICAgICAgICBtaW5Ob2RlLnBvc2l0aW9uLFxuICAgICAgICAgICAgbWF4Tm9kZS5wb3NpdGlvbixcbiAgICAgICAgICAgIHZhbHVlXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogV2Fsa3MgdGhlIG1vZGVsJ3MgdHJlZSB0byBmaW5kIHRoZSBub2RlcyBuZWVkZWQgdG8gYW5pbWF0ZSB0aGUgY29tcG9uZW50cyBhbmRcbiAgICogc2F2ZXMgdGhlbSBmb3IgdXNlIGluIHRoZSBmcmFtZSBsb29wXG4gICAqL1xuICBmaW5kTm9kZXMoKSB7XG4gICAgdGhpcy5ub2RlcyA9IHt9O1xuXG4gICAgLy8gTG9vcCB0aHJvdWdoIHRoZSBjb21wb25lbnRzIGFuZCBmaW5kIHRoZSBub2RlcyBuZWVkZWQgZm9yIGVhY2ggY29tcG9uZW50cycgdmlzdWFsIHJlc3BvbnNlc1xuICAgIE9iamVjdC52YWx1ZXModGhpcy5tb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudCkgPT4ge1xuICAgICAgY29uc3QgeyB0b3VjaFBvaW50Tm9kZU5hbWUsIHZpc3VhbFJlc3BvbnNlcyB9ID0gY29tcG9uZW50O1xuICAgICAgaWYgKHRvdWNoUG9pbnROb2RlTmFtZSkge1xuICAgICAgICB0aGlzLm5vZGVzW3RvdWNoUG9pbnROb2RlTmFtZV0gPSB0aGlzLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZSh0b3VjaFBvaW50Tm9kZU5hbWUpO1xuICAgICAgfVxuXG4gICAgICAvLyBMb29wIHRocm91Z2ggYWxsIHRoZSB2aXN1YWwgcmVzcG9uc2VzIHRvIGJlIGFwcGxpZWQgdG8gdGhpcyBjb21wb25lbnRcbiAgICAgIE9iamVjdC52YWx1ZXModmlzdWFsUmVzcG9uc2VzKS5mb3JFYWNoKCh2aXN1YWxSZXNwb25zZSkgPT4ge1xuICAgICAgICBjb25zdCB7XG4gICAgICAgICAgdmFsdWVOb2RlTmFtZSwgbWluTm9kZU5hbWUsIG1heE5vZGVOYW1lLCB2YWx1ZU5vZGVQcm9wZXJ0eVxuICAgICAgICB9ID0gdmlzdWFsUmVzcG9uc2U7XG4gICAgICAgIC8vIElmIGFuaW1hdGluZyBhIHRyYW5zZm9ybSwgZmluZCB0aGUgdHdvIG5vZGVzIHRvIGJlIGludGVycG9sYXRlZCBiZXR3ZWVuLlxuICAgICAgICBpZiAodmFsdWVOb2RlUHJvcGVydHkgPT09IENvbnN0YW50cy5WaXN1YWxSZXNwb25zZVByb3BlcnR5LlRSQU5TRk9STSkge1xuICAgICAgICAgIHRoaXMubm9kZXNbbWluTm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUobWluTm9kZU5hbWUpO1xuICAgICAgICAgIHRoaXMubm9kZXNbbWF4Tm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUobWF4Tm9kZU5hbWUpO1xuXG4gICAgICAgICAgLy8gSWYgdGhlIGV4dGVudHMgY2Fubm90IGJlIGZvdW5kLCBza2lwIHRoaXMgYW5pbWF0aW9uXG4gICAgICAgICAgaWYgKCF0aGlzLm5vZGVzW21pbk5vZGVOYW1lXSkge1xuICAgICAgICAgICAgQXNzZXRFcnJvci5sb2coYENvdWxkIG5vdCBmaW5kICR7bWluTm9kZU5hbWV9IGluIHRoZSBtb2RlbGApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoIXRoaXMubm9kZXNbbWF4Tm9kZU5hbWVdKSB7XG4gICAgICAgICAgICBBc3NldEVycm9yLmxvZyhgQ291bGQgbm90IGZpbmQgJHttYXhOb2RlTmFtZX0gaW4gdGhlIG1vZGVsYCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhlIHRhcmdldCBub2RlIGNhbm5vdCBiZSBmb3VuZCwgc2tpcCB0aGlzIGFuaW1hdGlvblxuICAgICAgICB0aGlzLm5vZGVzW3ZhbHVlTm9kZU5hbWVdID0gdGhpcy5yb290Tm9kZS5nZXRPYmplY3RCeU5hbWUodmFsdWVOb2RlTmFtZSk7XG4gICAgICAgIGlmICghdGhpcy5ub2Rlc1t2YWx1ZU5vZGVOYW1lXSkge1xuICAgICAgICAgIEFzc2V0RXJyb3IubG9nKGBDb3VsZCBub3QgZmluZCAke3ZhbHVlTm9kZU5hbWV9IGluIHRoZSBtb2RlbGApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGQgdG91Y2ggZG90cyB0byBhbGwgdG91Y2hwYWQgY29tcG9uZW50cyBzbyB0aGUgZmluZ2VyIGNhbiBiZSBzZWVuXG4gICAqL1xuICBhZGRUb3VjaERvdHMoKSB7XG4gICAgT2JqZWN0LmtleXModGhpcy5tb3Rpb25Db250cm9sbGVyLmNvbXBvbmVudHMpLmZvckVhY2goKGNvbXBvbmVudElkKSA9PiB7XG4gICAgICBjb25zdCBjb21wb25lbnQgPSB0aGlzLm1vdGlvbkNvbnRyb2xsZXIuY29tcG9uZW50c1tjb21wb25lbnRJZF07XG4gICAgICAvLyBGaW5kIHRoZSB0b3VjaHBhZHNcbiAgICAgIGlmIChjb21wb25lbnQudHlwZSA9PT0gQ29uc3RhbnRzLkNvbXBvbmVudFR5cGUuVE9VQ0hQQUQpIHtcbiAgICAgICAgLy8gRmluZCB0aGUgbm9kZSB0byBhdHRhY2ggdGhlIHRvdWNoIGRvdC5cbiAgICAgICAgY29uc3QgdG91Y2hQb2ludFJvb3QgPSB0aGlzLnJvb3ROb2RlLmdldE9iamVjdEJ5TmFtZShjb21wb25lbnQudG91Y2hQb2ludE5vZGVOYW1lLCB0cnVlKTtcbiAgICAgICAgaWYgKCF0b3VjaFBvaW50Um9vdCkge1xuICAgICAgICAgIEFzc2V0RXJyb3IubG9nKGBDb3VsZCBub3QgZmluZCB0b3VjaCBkb3QsICR7Y29tcG9uZW50LnRvdWNoUG9pbnROb2RlTmFtZX0sIGluIHRvdWNocGFkIGNvbXBvbmVudCAke2NvbXBvbmVudElkfWApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHNwaGVyZUdlb21ldHJ5ID0gbmV3IFRIUkVFLlNwaGVyZUdlb21ldHJ5KDAuMDAxKTtcbiAgICAgICAgICBjb25zdCBtYXRlcmlhbCA9IG5ldyBUSFJFRS5NZXNoQmFzaWNNYXRlcmlhbCh7IGNvbG9yOiAweDAwMDBGRiB9KTtcbiAgICAgICAgICBjb25zdCBzcGhlcmUgPSBuZXcgVEhSRUUuTWVzaChzcGhlcmVHZW9tZXRyeSwgbWF0ZXJpYWwpO1xuICAgICAgICAgIHRvdWNoUG9pbnRSb290LmFkZChzcGhlcmUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgQ29udHJvbGxlck1vZGVsO1xuIiwiLyogZXNsaW50LWRpc2FibGUgaW1wb3J0L25vLXVucmVzb2x2ZWQgKi9cbmltcG9ydCAnLi9hanYvYWp2Lm1pbi5qcyc7XG5pbXBvcnQgdmFsaWRhdGVSZWdpc3RyeVByb2ZpbGUgZnJvbSAnLi9yZWdpc3RyeVRvb2xzL3ZhbGlkYXRlUmVnaXN0cnlQcm9maWxlLmpzJztcbmltcG9ydCBleHBhbmRSZWdpc3RyeVByb2ZpbGUgZnJvbSAnLi9hc3NldFRvb2xzL2V4cGFuZFJlZ2lzdHJ5UHJvZmlsZS5qcyc7XG5pbXBvcnQgYnVpbGRBc3NldFByb2ZpbGUgZnJvbSAnLi9hc3NldFRvb2xzL2J1aWxkQXNzZXRQcm9maWxlLmpzJztcbi8qIGVzbGludC1lbmFibGUgKi9cblxuaW1wb3J0IEFzc2V0RXJyb3IgZnJvbSAnLi9hc3NldEVycm9yLmpzJztcblxuLyoqXG4gKiBMb2FkcyBhIHByb2ZpbGUgZnJvbSBhIHNldCBvZiBsb2NhbCBmaWxlc1xuICovXG5jbGFzcyBMb2NhbFByb2ZpbGUgZXh0ZW5kcyBFdmVudFRhcmdldCB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKCk7XG5cbiAgICB0aGlzLmxvY2FsRmlsZXNMaXN0RWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbEZpbGVzTGlzdCcpO1xuICAgIHRoaXMuZmlsZXNTZWxlY3RvciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbEZpbGVzU2VsZWN0b3InKTtcbiAgICB0aGlzLmZpbGVzU2VsZWN0b3IuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgdGhpcy5vbkZpbGVzU2VsZWN0ZWQoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuY2xlYXIoKTtcblxuICAgIExvY2FsUHJvZmlsZS5idWlsZFNjaGVtYVZhbGlkYXRvcigncmVnaXN0cnlUb29scy9yZWdpc3RyeVNjaGVtYXMuanNvbicpLnRoZW4oKHJlZ2lzdHJ5U2NoZW1hVmFsaWRhdG9yKSA9PiB7XG4gICAgICB0aGlzLnJlZ2lzdHJ5U2NoZW1hVmFsaWRhdG9yID0gcmVnaXN0cnlTY2hlbWFWYWxpZGF0b3I7XG4gICAgICBMb2NhbFByb2ZpbGUuYnVpbGRTY2hlbWFWYWxpZGF0b3IoJ2Fzc2V0VG9vbHMvYXNzZXRTY2hlbWFzLmpzb24nKS50aGVuKChhc3NldFNjaGVtYVZhbGlkYXRvcikgPT4ge1xuICAgICAgICB0aGlzLmFzc2V0U2NoZW1hVmFsaWRhdG9yID0gYXNzZXRTY2hlbWFWYWxpZGF0b3I7XG4gICAgICAgIGNvbnN0IGR1cmluZ1BhZ2VMb2FkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5vbkZpbGVzU2VsZWN0ZWQoZHVyaW5nUGFnZUxvYWQpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ2xlYXJzIGFsbCBsb2NhbCBwcm9maWxlIGluZm9ybWF0aW9uXG4gICAqL1xuICBjbGVhcigpIHtcbiAgICBpZiAodGhpcy5wcm9maWxlKSB7XG4gICAgICB0aGlzLnByb2ZpbGUgPSBudWxsO1xuICAgICAgdGhpcy5wcm9maWxlSWQgPSBudWxsO1xuICAgICAgdGhpcy5hc3NldHMgPSBbXTtcbiAgICAgIHRoaXMubG9jYWxGaWxlc0xpc3RFbGVtZW50LmlubmVySFRNTCA9ICcnO1xuXG4gICAgICBjb25zdCBjaGFuZ2VFdmVudCA9IG5ldyBFdmVudCgnbG9jYWxQcm9maWxlQ2hhbmdlJyk7XG4gICAgICB0aGlzLmRpc3BhdGNoRXZlbnQoY2hhbmdlRXZlbnQpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBQcm9jZXNzZXMgc2VsZWN0ZWQgZmlsZXMgYW5kIGdlbmVyYXRlcyBhbiBhc3NldCBwcm9maWxlXG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gZHVyaW5nUGFnZUxvYWRcbiAgICovXG4gIGFzeW5jIG9uRmlsZXNTZWxlY3RlZChkdXJpbmdQYWdlTG9hZCkge1xuICAgIHRoaXMuY2xlYXIoKTtcblxuICAgIC8vIFNraXAgaWYgaW5pdGlhbHphdGlvbiBpcyBpbmNvbXBsZXRlXG4gICAgaWYgKCF0aGlzLmFzc2V0U2NoZW1hVmFsaWRhdG9yKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gRXhhbWluZSB0aGUgZmlsZXMgc2VsZWN0ZWQgdG8gZmluZCB0aGUgcmVnaXN0cnkgcHJvZmlsZSwgYXNzZXQgb3ZlcnJpZGVzLCBhbmQgYXNzZXQgZmlsZXNcbiAgICBjb25zdCBhc3NldHMgPSBbXTtcbiAgICBsZXQgYXNzZXRKc29uRmlsZTtcbiAgICBsZXQgcmVnaXN0cnlKc29uRmlsZTtcblxuICAgIGNvbnN0IGZpbGVzTGlzdCA9IEFycmF5LmZyb20odGhpcy5maWxlc1NlbGVjdG9yLmZpbGVzKTtcbiAgICBmaWxlc0xpc3QuZm9yRWFjaCgoZmlsZSkgPT4ge1xuICAgICAgaWYgKGZpbGUubmFtZS5lbmRzV2l0aCgnLmdsYicpKSB7XG4gICAgICAgIGFzc2V0c1tmaWxlLm5hbWVdID0gd2luZG93LlVSTC5jcmVhdGVPYmplY3RVUkwoZmlsZSk7XG4gICAgICB9IGVsc2UgaWYgKGZpbGUubmFtZSA9PT0gJ3Byb2ZpbGUuanNvbicpIHtcbiAgICAgICAgYXNzZXRKc29uRmlsZSA9IGZpbGU7XG4gICAgICB9IGVsc2UgaWYgKGZpbGUubmFtZS5lbmRzV2l0aCgnLmpzb24nKSkge1xuICAgICAgICByZWdpc3RyeUpzb25GaWxlID0gZmlsZTtcbiAgICAgIH1cblxuICAgICAgLy8gTGlzdCB0aGUgZmlsZXMgZm91bmRcbiAgICAgIHRoaXMubG9jYWxGaWxlc0xpc3RFbGVtZW50LmlubmVySFRNTCArPSBgXG4gICAgICAgIDxsaT4ke2ZpbGUubmFtZX08L2xpPlxuICAgICAgYDtcbiAgICB9KTtcblxuICAgIGlmICghcmVnaXN0cnlKc29uRmlsZSkge1xuICAgICAgQXNzZXRFcnJvci5sb2coJ05vIHJlZ2lzdHJ5IHByb2ZpbGUgc2VsZWN0ZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmJ1aWxkUHJvZmlsZShyZWdpc3RyeUpzb25GaWxlLCBhc3NldEpzb25GaWxlLCBhc3NldHMpO1xuICAgIHRoaXMuYXNzZXRzID0gYXNzZXRzO1xuXG4gICAgLy8gQ2hhbmdlIHRoZSBzZWxlY3RlZCBwcm9maWxlIHRvIHRoZSBvbmUganVzdCBsb2FkZWQuICBEbyBub3QgZG8gdGhpcyBvbiBpbml0aWFsIHBhZ2UgbG9hZFxuICAgIC8vIGJlY2F1c2UgdGhlIHNlbGVjdGVkIGZpbGVzIHBlcnNpc3RzIGluIGZpcmVmb3ggYWNyb3NzIHJlZnJlc2hlcywgYnV0IHRoZSB1c2VyIG1heSBoYXZlXG4gICAgLy8gc2VsZWN0ZWQgYSBkaWZmZXJlbnQgaXRlbSBmcm9tIHRoZSBkcm9wZG93blxuICAgIGlmICghZHVyaW5nUGFnZUxvYWQpIHtcbiAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbSgncHJvZmlsZUlkJywgdGhpcy5wcm9maWxlSWQpO1xuICAgIH1cblxuICAgIC8vIE5vdGlmeSB0aGF0IHRoZSBsb2NhbCBwcm9maWxlIGlzIHJlYWR5IGZvciB1c2VcbiAgICBjb25zdCBjaGFuZ2VFdmVudCA9IG5ldyBFdmVudCgnbG9jYWxwcm9maWxlY2hhbmdlJyk7XG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KGNoYW5nZUV2ZW50KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZCBhIG1lcmdlZCBwcm9maWxlIGZpbGUgZnJvbSB0aGUgcmVnaXN0cnkgcHJvZmlsZSBhbmQgYXNzZXQgb3ZlcnJpZGVzXG4gICAqIEBwYXJhbSB7Kn0gcmVnaXN0cnlKc29uRmlsZVxuICAgKiBAcGFyYW0geyp9IGFzc2V0SnNvbkZpbGVcbiAgICovXG4gIGFzeW5jIGJ1aWxkUHJvZmlsZShyZWdpc3RyeUpzb25GaWxlLCBhc3NldEpzb25GaWxlKSB7XG4gICAgLy8gTG9hZCB0aGUgcmVnaXN0cnkgSlNPTiBhbmQgdmFsaWRhdGUgaXQgYWdhaW5zdCB0aGUgc2NoZW1hXG4gICAgY29uc3QgcmVnaXN0cnlKc29uID0gYXdhaXQgTG9jYWxQcm9maWxlLmxvYWRMb2NhbEpzb24ocmVnaXN0cnlKc29uRmlsZSk7XG4gICAgY29uc3QgaXNSZWdpc3RyeUpzb25WYWxpZCA9IHRoaXMucmVnaXN0cnlTY2hlbWFWYWxpZGF0b3IocmVnaXN0cnlKc29uKTtcbiAgICBpZiAoIWlzUmVnaXN0cnlKc29uVmFsaWQpIHtcbiAgICAgIHRocm93IG5ldyBBc3NldEVycm9yKEpTT04uc3RyaW5naWZ5KHRoaXMucmVnaXN0cnlTY2hlbWFWYWxpZGF0b3IuZXJyb3JzLCBudWxsLCAyKSk7XG4gICAgfVxuXG4gICAgLy8gTG9hZCB0aGUgYXNzZXQgSlNPTiBhbmQgdmFsaWRhdGUgaXQgYWdhaW5zdCB0aGUgc2NoZW1hLlxuICAgIC8vIElmIG5vIGFzc2V0IEpTT04gcHJlc2VudCwgdXNlIHRoZSBkZWZhdWx0IGRlZmluaXRvblxuICAgIGxldCBhc3NldEpzb247XG4gICAgaWYgKCFhc3NldEpzb25GaWxlKSB7XG4gICAgICBhc3NldEpzb24gPSB7IHByb2ZpbGVJZDogcmVnaXN0cnlKc29uLnByb2ZpbGVJZCwgb3ZlcnJpZGVzOiB7fSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBhc3NldEpzb24gPSBhd2FpdCBMb2NhbFByb2ZpbGUubG9hZExvY2FsSnNvbihhc3NldEpzb25GaWxlKTtcbiAgICAgIGNvbnN0IGlzQXNzZXRKc29uVmFsaWQgPSB0aGlzLmFzc2V0U2NoZW1hVmFsaWRhdG9yKGFzc2V0SnNvbik7XG4gICAgICBpZiAoIWlzQXNzZXRKc29uVmFsaWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEFzc2V0RXJyb3IoSlNPTi5zdHJpbmdpZnkodGhpcy5hc3NldFNjaGVtYVZhbGlkYXRvci5lcnJvcnMsIG51bGwsIDIpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSBub24tc2NoZW1hIHJlcXVpcmVtZW50cyBhbmQgYnVpbGQgYSBjb21iaW5lZCBwcm9maWxlXG4gICAgdmFsaWRhdGVSZWdpc3RyeVByb2ZpbGUocmVnaXN0cnlKc29uKTtcbiAgICBjb25zdCBleHBhbmRlZFJlZ2lzdHJ5UHJvZmlsZSA9IGV4cGFuZFJlZ2lzdHJ5UHJvZmlsZShyZWdpc3RyeUpzb24pO1xuICAgIHRoaXMucHJvZmlsZSA9IGJ1aWxkQXNzZXRQcm9maWxlKGFzc2V0SnNvbiwgZXhwYW5kZWRSZWdpc3RyeVByb2ZpbGUpO1xuICAgIHRoaXMucHJvZmlsZUlkID0gdGhpcy5wcm9maWxlLnByb2ZpbGVJZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBIZWxwZXIgdG8gbG9hZCBKU09OIGZyb20gYSBsb2NhbCBmaWxlXG4gICAqIEBwYXJhbSB7RmlsZX0ganNvbkZpbGVcbiAgICovXG4gIHN0YXRpYyBsb2FkTG9jYWxKc29uKGpzb25GaWxlKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlYWRlciA9IG5ldyBGaWxlUmVhZGVyKCk7XG5cbiAgICAgIHJlYWRlci5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJlYWRlci5yZXN1bHQpO1xuICAgICAgICByZXNvbHZlKGpzb24pO1xuICAgICAgfTtcblxuICAgICAgcmVhZGVyLm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBVbmFibGUgdG8gbG9hZCBKU09OIGZyb20gJHtqc29uRmlsZS5uYW1lfWA7XG4gICAgICAgIEFzc2V0RXJyb3IubG9nKGVycm9yTWVzc2FnZSk7XG4gICAgICAgIHJlamVjdChlcnJvck1lc3NhZ2UpO1xuICAgICAgfTtcblxuICAgICAgcmVhZGVyLnJlYWRBc1RleHQoanNvbkZpbGUpO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEhlbHBlciB0byBsb2FkIHRoZSBjb21iaW5lZCBzY2hlbWEgZmlsZSBhbmQgY29tcGlsZSBhbiBBSlYgdmFsaWRhdG9yXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBzY2hlbWFzUGF0aFxuICAgKi9cbiAgc3RhdGljIGFzeW5jIGJ1aWxkU2NoZW1hVmFsaWRhdG9yKHNjaGVtYXNQYXRoKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChzY2hlbWFzUGF0aCk7XG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgdGhyb3cgbmV3IEFzc2V0RXJyb3IocmVzcG9uc2Uuc3RhdHVzVGV4dCk7XG4gICAgfVxuXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLXVuZGVmXG4gICAgY29uc3QgYWp2ID0gbmV3IEFqdigpO1xuICAgIGNvbnN0IHNjaGVtYXMgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gICAgc2NoZW1hcy5kZXBlbmRlbmNpZXMuZm9yRWFjaCgoc2NoZW1hKSA9PiB7XG4gICAgICBhanYuYWRkU2NoZW1hKHNjaGVtYSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gYWp2LmNvbXBpbGUoc2NoZW1hcy5tYWluU2NoZW1hKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBMb2NhbFByb2ZpbGU7XG4iLCIvKiBlc2xpbnQtZGlzYWJsZSBpbXBvcnQvbm8tdW5yZXNvbHZlZCAqL1xuaW1wb3J0IHsgZmV0Y2hQcm9maWxlLCBmZXRjaFByb2ZpbGVzTGlzdCwgTW90aW9uQ29udHJvbGxlciB9IGZyb20gJy4vbW90aW9uLWNvbnRyb2xsZXJzLm1vZHVsZS5qcyc7XG4vKiBlc2xpbnQtZW5hYmxlICovXG5cbmltcG9ydCBBc3NldEVycm9yIGZyb20gJy4vYXNzZXRFcnJvci5qcyc7XG5pbXBvcnQgTG9jYWxQcm9maWxlIGZyb20gJy4vbG9jYWxQcm9maWxlLmpzJztcblxuY29uc3QgcHJvZmlsZXNCYXNlUGF0aCA9ICcuL3Byb2ZpbGVzJztcblxuLyoqXG4gKiBMb2FkcyBwcm9maWxlcyBmcm9tIHRoZSBkaXN0cmlidXRpb24gZm9sZGVyIG5leHQgdG8gdGhlIHZpZXdlcidzIGxvY2F0aW9uXG4gKi9cbmNsYXNzIFByb2ZpbGVTZWxlY3RvciBleHRlbmRzIEV2ZW50VGFyZ2V0IHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcblxuICAgIC8vIEdldCB0aGUgcHJvZmlsZSBpZCBzZWxlY3RvciBhbmQgbGlzdGVuIGZvciBjaGFuZ2VzXG4gICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUlkU2VsZWN0b3InKTtcbiAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IHRoaXMub25Qcm9maWxlSWRDaGFuZ2UoKTsgfSk7XG5cbiAgICAvLyBHZXQgdGhlIGhhbmRlZG5lc3Mgc2VsZWN0b3IgYW5kIGxpc3RlbiBmb3IgY2hhbmdlc1xuICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yRWxlbWVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYW5kZWRuZXNzU2VsZWN0b3InKTtcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyB0aGlzLm9uSGFuZGVkbmVzc0NoYW5nZSgpOyB9KTtcblxuICAgIHRoaXMubG9jYWxQcm9maWxlID0gbmV3IExvY2FsUHJvZmlsZSgpO1xuICAgIHRoaXMubG9jYWxQcm9maWxlLmFkZEV2ZW50TGlzdGVuZXIoJ2xvY2FscHJvZmlsZWNoYW5nZScsIChldmVudCkgPT4geyB0aGlzLm9uTG9jYWxQcm9maWxlQ2hhbmdlKGV2ZW50KTsgfSk7XG5cbiAgICB0aGlzLnByb2ZpbGVzTGlzdCA9IG51bGw7XG4gICAgdGhpcy5wb3B1bGF0ZVByb2ZpbGVTZWxlY3RvcigpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc2V0cyBhbGwgc2VsZWN0ZWQgcHJvZmlsZSBzdGF0ZVxuICAgKi9cbiAgY2xlYXJTZWxlY3RlZFByb2ZpbGUoKSB7XG4gICAgQXNzZXRFcnJvci5jbGVhckFsbCgpO1xuICAgIHRoaXMucHJvZmlsZSA9IG51bGw7XG4gICAgdGhpcy5oYW5kZWRuZXNzID0gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXRyaWV2ZXMgdGhlIGZ1bGwgbGlzdCBvZiBhdmFpbGFibGUgcHJvZmlsZXMgYW5kIHBvcHVsYXRlcyB0aGUgZHJvcGRvd25cbiAgICovXG4gIGFzeW5jIHBvcHVsYXRlUHJvZmlsZVNlbGVjdG9yKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XG5cbiAgICAvLyBMb2FkIGFuZCBjbGVhciBsb2NhbCBzdG9yYWdlXG4gICAgY29uc3Qgc3RvcmVkUHJvZmlsZUlkID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKCdwcm9maWxlSWQnKTtcbiAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oJ3Byb2ZpbGVJZCcpO1xuXG4gICAgLy8gTG9hZCB0aGUgbGlzdCBvZiBwcm9maWxlc1xuICAgIGlmICghdGhpcy5wcm9maWxlc0xpc3QpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPVwibG9hZGluZ1wiPkxvYWRpbmcuLi48L29wdGlvbj4nO1xuICAgICAgICB0aGlzLnByb2ZpbGVzTGlzdCA9IGF3YWl0IGZldGNoUHJvZmlsZXNMaXN0KHByb2ZpbGVzQmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJ0ZhaWxlZCB0byBsb2FkIGxpc3QnO1xuICAgICAgICBBc3NldEVycm9yLmxvZyhlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQWRkIGVhY2ggcHJvZmlsZSB0byB0aGUgZHJvcGRvd25cbiAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgPSAnJztcbiAgICBPYmplY3Qua2V5cyh0aGlzLnByb2ZpbGVzTGlzdCkuZm9yRWFjaCgocHJvZmlsZUlkKSA9PiB7XG4gICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgPG9wdGlvbiB2YWx1ZT0nJHtwcm9maWxlSWR9Jz4ke3Byb2ZpbGVJZH08L29wdGlvbj5cbiAgICAgIGA7XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgdGhlIGxvY2FsIHByb2ZpbGUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBpbmNsdWRlZFxuICAgIGlmICh0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlSWRcbiAgICAgJiYgIU9iamVjdC5rZXlzKHRoaXMucHJvZmlsZXNMaXN0KS5pbmNsdWRlcyh0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlSWQpKSB7XG4gICAgICB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgPG9wdGlvbiB2YWx1ZT0nJHt0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlSWR9Jz4ke3RoaXMubG9jYWxQcm9maWxlLnByb2ZpbGVJZH08L29wdGlvbj5cbiAgICAgIGA7XG4gICAgfVxuXG4gICAgLy8gT3ZlcnJpZGUgdGhlIGRlZmF1bHQgc2VsZWN0aW9uIGlmIHZhbHVlcyB3ZXJlIHByZXNlbnQgaW4gbG9jYWwgc3RvcmFnZVxuICAgIGlmIChzdG9yZWRQcm9maWxlSWQpIHtcbiAgICAgIHRoaXMucHJvZmlsZUlkU2VsZWN0b3JFbGVtZW50LnZhbHVlID0gc3RvcmVkUHJvZmlsZUlkO1xuICAgIH1cblxuICAgIC8vIE1hbnVhbGx5IHRyaWdnZXIgc2VsZWN0ZWQgcHJvZmlsZSB0byBsb2FkXG4gICAgdGhpcy5vblByb2ZpbGVJZENoYW5nZSgpO1xuICB9XG5cbiAgLyoqXG4gICAqIEhhbmRsZXIgZm9yIHRoZSBwcm9maWxlIGlkIHNlbGVjdGlvbiBjaGFuZ2VcbiAgICovXG4gIG9uUHJvZmlsZUlkQ2hhbmdlKCkge1xuICAgIHRoaXMuY2xlYXJTZWxlY3RlZFByb2ZpbGUoKTtcbiAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuaW5uZXJIVE1MID0gJyc7XG5cbiAgICBjb25zdCBwcm9maWxlSWQgPSB0aGlzLnByb2ZpbGVJZFNlbGVjdG9yRWxlbWVudC52YWx1ZTtcbiAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3Byb2ZpbGVJZCcsIHByb2ZpbGVJZCk7XG5cbiAgICBpZiAocHJvZmlsZUlkID09PSB0aGlzLmxvY2FsUHJvZmlsZS5wcm9maWxlSWQpIHtcbiAgICAgIHRoaXMucHJvZmlsZSA9IHRoaXMubG9jYWxQcm9maWxlLnByb2ZpbGU7XG4gICAgICB0aGlzLnBvcHVsYXRlSGFuZGVkbmVzc1NlbGVjdG9yKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEF0dGVtcHQgdG8gbG9hZCB0aGUgcHJvZmlsZVxuICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIGZldGNoUHJvZmlsZSh7IHByb2ZpbGVzOiBbcHJvZmlsZUlkXSB9LCBwcm9maWxlc0Jhc2VQYXRoLCBmYWxzZSkudGhlbigoeyBwcm9maWxlIH0pID0+IHtcbiAgICAgICAgdGhpcy5wcm9maWxlID0gcHJvZmlsZTtcbiAgICAgICAgdGhpcy5wb3B1bGF0ZUhhbmRlZG5lc3NTZWxlY3RvcigpO1xuICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIEFzc2V0RXJyb3IubG9nKGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgdGhpcy5wcm9maWxlSWRTZWxlY3RvckVsZW1lbnQuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICB0aGlzLmhhbmRlZG5lc3NTZWxlY3RvckVsZW1lbnQuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFBvcHVsYXRlcyB0aGUgaGFuZGVkbmVzcyBkcm9wZG93biB3aXRoIHRob3NlIHN1cHBvcnRlZCBieSB0aGUgc2VsZWN0ZWQgcHJvZmlsZVxuICAgKi9cbiAgcG9wdWxhdGVIYW5kZWRuZXNzU2VsZWN0b3IoKSB7XG4gICAgLy8gTG9hZCBhbmQgY2xlYXIgdGhlIGxhc3Qgc2VsZWN0aW9uIGZvciB0aGlzIHByb2ZpbGUgaWRcbiAgICBjb25zdCBzdG9yZWRIYW5kZWRuZXNzID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKCdoYW5kZWRuZXNzJyk7XG4gICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKCdoYW5kZWRuZXNzJyk7XG5cbiAgICAvLyBQb3B1bGF0ZSBoYW5kZWRuZXNzIHNlbGVjdG9yXG4gICAgT2JqZWN0LmtleXModGhpcy5wcm9maWxlLmxheW91dHMpLmZvckVhY2goKGhhbmRlZG5lc3MpID0+IHtcbiAgICAgIHRoaXMuaGFuZGVkbmVzc1NlbGVjdG9yRWxlbWVudC5pbm5lckhUTUwgKz0gYFxuICAgICAgICA8b3B0aW9uIHZhbHVlPScke2hhbmRlZG5lc3N9Jz4ke2hhbmRlZG5lc3N9PC9vcHRpb24+XG4gICAgICBgO1xuICAgIH0pO1xuXG4gICAgLy8gQXBwbHkgc3RvcmVkIGhhbmRlZG5lc3MgaWYgZm91bmRcbiAgICBpZiAoc3RvcmVkSGFuZGVkbmVzcyAmJiB0aGlzLnByb2ZpbGUubGF5b3V0c1tzdG9yZWRIYW5kZWRuZXNzXSkge1xuICAgICAgdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LnZhbHVlID0gc3RvcmVkSGFuZGVkbmVzcztcbiAgICB9XG5cbiAgICAvLyBNYW51YWxseSB0cmlnZ2VyIHNlbGVjdGVkIGhhbmRlZG5lc3MgY2hhbmdlXG4gICAgdGhpcy5vbkhhbmRlZG5lc3NDaGFuZ2UoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25kcyB0byBjaGFuZ2VzIGluIHNlbGVjdGVkIGhhbmRlZG5lc3MuXG4gICAqIENyZWF0ZXMgYSBuZXcgbW90aW9uIGNvbnRyb2xsZXIgZm9yIHRoZSBjb21iaW5hdGlvbiBvZiBwcm9maWxlIGFuZCBoYW5kZWRuZXNzLCBhbmQgZmlyZXMgYW5cbiAgICogZXZlbnQgdG8gc2lnbmFsIHRoZSBjaGFuZ2VcbiAgICovXG4gIG9uSGFuZGVkbmVzc0NoYW5nZSgpIHtcbiAgICBBc3NldEVycm9yLmNsZWFyQWxsKCk7XG4gICAgdGhpcy5oYW5kZWRuZXNzID0gdGhpcy5oYW5kZWRuZXNzU2VsZWN0b3JFbGVtZW50LnZhbHVlO1xuICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaGFuZGVkbmVzcycsIHRoaXMuaGFuZGVkbmVzcyk7XG4gICAgaWYgKHRoaXMuaGFuZGVkbmVzcykge1xuICAgICAgdGhpcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnc2VsZWN0aW9uY2hhbmdlJykpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdzZWxlY3Rpb25jbGVhcicpKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogVXBkYXRlcyB0aGUgcHJvZmlsZXMgZHJvcGRvd24gdG8gZW5zdXJlIGxvY2FsIHByb2ZpbGUgaXMgaW4gdGhlIGxpc3RcbiAgICovXG4gIG9uTG9jYWxQcm9maWxlQ2hhbmdlKCkge1xuICAgIHRoaXMucG9wdWxhdGVQcm9maWxlU2VsZWN0b3IoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZHMgYSBNb3Rpb25Db250cm9sbGVyIGVpdGhlciBiYXNlZCBvbiB0aGUgc3VwcGxpZWQgaW5wdXQgc291cmNlIHVzaW5nIHRoZSBsb2NhbCBwcm9maWxlXG4gICAqIGlmIGl0IGlzIHRoZSBiZXN0IG1hdGNoLCBvdGhlcndpc2UgdXNlcyB0aGUgcmVtb3RlIGFzc2V0c1xuICAgKiBAcGFyYW0ge1hSSW5wdXRTb3VyY2V9IHhySW5wdXRTb3VyY2VcbiAgICovXG4gIGFzeW5jIGNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIoeHJJbnB1dFNvdXJjZSkge1xuICAgIGxldCBwcm9maWxlO1xuICAgIGxldCBhc3NldFBhdGg7XG5cbiAgICAvLyBDaGVjayBpZiBsb2NhbCBvdmVycmlkZSBzaG91bGQgYmUgdXNlZFxuICAgIGxldCB1c2VMb2NhbFByb2ZpbGUgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkKSB7XG4gICAgICB4cklucHV0U291cmNlLnByb2ZpbGVzLnNvbWUoKHByb2ZpbGVJZCkgPT4ge1xuICAgICAgICBjb25zdCBtYXRjaEZvdW5kID0gT2JqZWN0LmtleXModGhpcy5wcm9maWxlc0xpc3QpLmluY2x1ZGVzKHByb2ZpbGVJZCk7XG4gICAgICAgIHVzZUxvY2FsUHJvZmlsZSA9IG1hdGNoRm91bmQgJiYgKHByb2ZpbGVJZCA9PT0gdGhpcy5sb2NhbFByb2ZpbGUucHJvZmlsZUlkKTtcbiAgICAgICAgcmV0dXJuIG1hdGNoRm91bmQ7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBHZXQgcHJvZmlsZSBhbmQgYXNzZXQgcGF0aFxuICAgIGlmICh1c2VMb2NhbFByb2ZpbGUpIHtcbiAgICAgICh7IHByb2ZpbGUgfSA9IHRoaXMubG9jYWxQcm9maWxlKTtcbiAgICAgIGNvbnN0IGFzc2V0TmFtZSA9IHRoaXMubG9jYWxQcm9maWxlLnByb2ZpbGUubGF5b3V0c1t4cklucHV0U291cmNlLmhhbmRlZG5lc3NdLmFzc2V0UGF0aDtcbiAgICAgIGFzc2V0UGF0aCA9IHRoaXMubG9jYWxQcm9maWxlLmFzc2V0c1thc3NldE5hbWVdIHx8IGFzc2V0TmFtZTtcbiAgICB9IGVsc2Uge1xuICAgICAgKHsgcHJvZmlsZSwgYXNzZXRQYXRoIH0gPSBhd2FpdCBmZXRjaFByb2ZpbGUoeHJJbnB1dFNvdXJjZSwgcHJvZmlsZXNCYXNlUGF0aCkpO1xuICAgIH1cblxuICAgIC8vIEJ1aWxkIG1vdGlvbiBjb250cm9sbGVyXG4gICAgY29uc3QgbW90aW9uQ29udHJvbGxlciA9IG5ldyBNb3Rpb25Db250cm9sbGVyKFxuICAgICAgeHJJbnB1dFNvdXJjZSxcbiAgICAgIHByb2ZpbGUsXG4gICAgICBhc3NldFBhdGhcbiAgICApO1xuXG4gICAgcmV0dXJuIG1vdGlvbkNvbnRyb2xsZXI7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgUHJvZmlsZVNlbGVjdG9yO1xuIiwiY29uc3QgQ29uc3RhbnRzID0ge1xuICBIYW5kZWRuZXNzOiBPYmplY3QuZnJlZXplKHtcbiAgICBOT05FOiAnbm9uZScsXG4gICAgTEVGVDogJ2xlZnQnLFxuICAgIFJJR0hUOiAncmlnaHQnXG4gIH0pLFxuXG4gIENvbXBvbmVudFN0YXRlOiBPYmplY3QuZnJlZXplKHtcbiAgICBERUZBVUxUOiAnZGVmYXVsdCcsXG4gICAgVE9VQ0hFRDogJ3RvdWNoZWQnLFxuICAgIFBSRVNTRUQ6ICdwcmVzc2VkJ1xuICB9KSxcblxuICBDb21wb25lbnRQcm9wZXJ0eTogT2JqZWN0LmZyZWV6ZSh7XG4gICAgQlVUVE9OOiAnYnV0dG9uJyxcbiAgICBYX0FYSVM6ICd4QXhpcycsXG4gICAgWV9BWElTOiAneUF4aXMnLFxuICAgIFNUQVRFOiAnc3RhdGUnXG4gIH0pLFxuXG4gIENvbXBvbmVudFR5cGU6IE9iamVjdC5mcmVlemUoe1xuICAgIFRSSUdHRVI6ICd0cmlnZ2VyJyxcbiAgICBTUVVFRVpFOiAnc3F1ZWV6ZScsXG4gICAgVE9VQ0hQQUQ6ICd0b3VjaHBhZCcsXG4gICAgVEhVTUJTVElDSzogJ3RodW1ic3RpY2snLFxuICAgIEJVVFRPTjogJ2J1dHRvbidcbiAgfSksXG5cbiAgQnV0dG9uVG91Y2hUaHJlc2hvbGQ6IDAuMDUsXG5cbiAgQXhpc1RvdWNoVGhyZXNob2xkOiAwLjEsXG5cbiAgVmlzdWFsUmVzcG9uc2VQcm9wZXJ0eTogT2JqZWN0LmZyZWV6ZSh7XG4gICAgVFJBTlNGT1JNOiAndHJhbnNmb3JtJyxcbiAgICBWSVNJQklMSVRZOiAndmlzaWJpbGl0eSdcbiAgfSlcbn07XG5cbmV4cG9ydCBkZWZhdWx0IENvbnN0YW50cztcbiIsImltcG9ydCBDb25zdGFudHMgZnJvbSAnLi4vLi4vLi4vbW90aW9uLWNvbnRyb2xsZXJzL3NyYy9jb25zdGFudHMuanMnO1xuXG4vKipcbiAqIEEgZmFsc2UgZ2FtZXBhZCB0byBiZSB1c2VkIGluIHRlc3RzXG4gKi9cbmNsYXNzIE1vY2tHYW1lcGFkIHtcbiAgLyoqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBwcm9maWxlRGVzY3JpcHRpb24gLSBUaGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBwYXJzZSB0byBkZXRlcm1pbmUgdGhlIGxlbmd0aFxuICAgKiBvZiB0aGUgYnV0dG9uIGFuZCBheGVzIGFycmF5c1xuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBnYW1lcGFkJ3MgaGFuZGVkbmVzc1xuICAgKi9cbiAgY29uc3RydWN0b3IocHJvZmlsZURlc2NyaXB0aW9uLCBoYW5kZWRuZXNzKSB7XG4gICAgaWYgKCFwcm9maWxlRGVzY3JpcHRpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gcHJvZmlsZURlc2NyaXB0aW9uIHN1cHBsaWVkJyk7XG4gICAgfVxuXG4gICAgaWYgKCFoYW5kZWRuZXNzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIGhhbmRlZG5lc3Mgc3VwcGxpZWQnKTtcbiAgICB9XG5cbiAgICB0aGlzLmlkID0gcHJvZmlsZURlc2NyaXB0aW9uLnByb2ZpbGVJZDtcblxuICAgIC8vIExvb3AgdGhyb3VnaCB0aGUgcHJvZmlsZSBkZXNjcmlwdGlvbiB0byBkZXRlcm1pbmUgaG93IG1hbnkgZWxlbWVudHMgdG8gcHV0IGluIHRoZSBidXR0b25zXG4gICAgLy8gYW5kIGF4ZXMgYXJyYXlzXG4gICAgbGV0IG1heEJ1dHRvbkluZGV4ID0gMDtcbiAgICBsZXQgbWF4QXhpc0luZGV4ID0gMDtcbiAgICBjb25zdCBsYXlvdXQgPSBwcm9maWxlRGVzY3JpcHRpb24ubGF5b3V0c1toYW5kZWRuZXNzXTtcbiAgICB0aGlzLm1hcHBpbmcgPSBsYXlvdXQubWFwcGluZztcbiAgICBPYmplY3QudmFsdWVzKGxheW91dC5jb21wb25lbnRzKS5mb3JFYWNoKCh7IGdhbWVwYWRJbmRpY2VzIH0pID0+IHtcbiAgICAgIGNvbnN0IHtcbiAgICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5CVVRUT05dOiBidXR0b25JbmRleCxcbiAgICAgICAgW0NvbnN0YW50cy5Db21wb25lbnRQcm9wZXJ0eS5YX0FYSVNdOiB4QXhpc0luZGV4LFxuICAgICAgICBbQ29uc3RhbnRzLkNvbXBvbmVudFByb3BlcnR5LllfQVhJU106IHlBeGlzSW5kZXhcbiAgICAgIH0gPSBnYW1lcGFkSW5kaWNlcztcblxuICAgICAgaWYgKGJ1dHRvbkluZGV4ICE9PSB1bmRlZmluZWQgJiYgYnV0dG9uSW5kZXggPiBtYXhCdXR0b25JbmRleCkge1xuICAgICAgICBtYXhCdXR0b25JbmRleCA9IGJ1dHRvbkluZGV4O1xuICAgICAgfVxuXG4gICAgICBpZiAoeEF4aXNJbmRleCAhPT0gdW5kZWZpbmVkICYmICh4QXhpc0luZGV4ID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSB4QXhpc0luZGV4O1xuICAgICAgfVxuXG4gICAgICBpZiAoeUF4aXNJbmRleCAhPT0gdW5kZWZpbmVkICYmICh5QXhpc0luZGV4ID4gbWF4QXhpc0luZGV4KSkge1xuICAgICAgICBtYXhBeGlzSW5kZXggPSB5QXhpc0luZGV4O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gRmlsbCB0aGUgYXhlcyBhcnJheVxuICAgIHRoaXMuYXhlcyA9IFtdO1xuICAgIHdoaWxlICh0aGlzLmF4ZXMubGVuZ3RoIDw9IG1heEF4aXNJbmRleCkge1xuICAgICAgdGhpcy5heGVzLnB1c2goMCk7XG4gICAgfVxuXG4gICAgLy8gRmlsbCB0aGUgYnV0dG9ucyBhcnJheVxuICAgIHRoaXMuYnV0dG9ucyA9IFtdO1xuICAgIHdoaWxlICh0aGlzLmJ1dHRvbnMubGVuZ3RoIDw9IG1heEJ1dHRvbkluZGV4KSB7XG4gICAgICB0aGlzLmJ1dHRvbnMucHVzaCh7XG4gICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB0b3VjaGVkOiBmYWxzZSxcbiAgICAgICAgcHJlc3NlZDogZmFsc2VcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb2NrR2FtZXBhZDtcbiIsIi8qKlxuICogQSBmYWtlIFhSSW5wdXRTb3VyY2UgdGhhdCBjYW4gYmUgdXNlZCB0byBpbml0aWFsaXplIGEgTW90aW9uQ29udHJvbGxlclxuICovXG5jbGFzcyBNb2NrWFJJbnB1dFNvdXJjZSB7XG4gIC8qKlxuICAgKiBAcGFyYW0ge09iamVjdH0gZ2FtZXBhZCAtIFRoZSBHYW1lcGFkIG9iamVjdCB0aGF0IHByb3ZpZGVzIHRoZSBidXR0b24gYW5kIGF4aXMgZGF0YVxuICAgKiBAcGFyYW0ge3N0cmluZ30gaGFuZGVkbmVzcyAtIFRoZSBoYW5kZWRuZXNzIHRvIHJlcG9ydFxuICAgKi9cbiAgY29uc3RydWN0b3IoZ2FtZXBhZCwgaGFuZGVkbmVzcykge1xuICAgIHRoaXMuZ2FtZXBhZCA9IGdhbWVwYWQ7XG5cbiAgICBpZiAoIWhhbmRlZG5lc3MpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gaGFuZGVkbmVzcyBzdXBwbGllZCcpO1xuICAgIH1cblxuICAgIHRoaXMuaGFuZGVkbmVzcyA9IGhhbmRlZG5lc3M7XG4gICAgdGhpcy5wcm9maWxlcyA9IE9iamVjdC5mcmVlemUoW3RoaXMuZ2FtZXBhZC5pZF0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IE1vY2tYUklucHV0U291cmNlO1xuIiwiLyogZXNsaW50LWRpc2FibGUgaW1wb3J0L25vLXVucmVzb2x2ZWQgKi9cbmltcG9ydCAqIGFzIFRIUkVFIGZyb20gJy4vdGhyZWUvYnVpbGQvdGhyZWUubW9kdWxlLmpzJztcbmltcG9ydCB7IE9yYml0Q29udHJvbHMgfSBmcm9tICcuL3RocmVlL2V4YW1wbGVzL2pzbS9jb250cm9scy9PcmJpdENvbnRyb2xzLmpzJztcbmltcG9ydCB7IFZSQnV0dG9uIH0gZnJvbSAnLi90aHJlZS9leGFtcGxlcy9qc20vd2VieHIvVlJCdXR0b24uanMnO1xuLyogZXNsaW50LWVuYWJsZSAqL1xuXG5pbXBvcnQgTWFudWFsQ29udHJvbHMgZnJvbSAnLi9tYW51YWxDb250cm9scy5qcyc7XG5pbXBvcnQgQ29udHJvbGxlck1vZGVsIGZyb20gJy4vY29udHJvbGxlck1vZGVsLmpzJztcbmltcG9ydCBQcm9maWxlU2VsZWN0b3IgZnJvbSAnLi9wcm9maWxlU2VsZWN0b3IuanMnO1xuaW1wb3J0IEFzc2V0RXJyb3IgZnJvbSAnLi9hc3NldEVycm9yLmpzJztcbmltcG9ydCBNb2NrR2FtZXBhZCBmcm9tICcuL21vY2tzL21vY2tHYW1lcGFkLmpzJztcbmltcG9ydCBNb2NrWFJJbnB1dFNvdXJjZSBmcm9tICcuL21vY2tzL21vY2tYUklucHV0U291cmNlLmpzJztcblxuY29uc3QgdGhyZWUgPSB7fTtcbmxldCBjYW52YXNQYXJlbnRFbGVtZW50O1xuXG5sZXQgcHJvZmlsZVNlbGVjdG9yO1xubGV0IG1vY2tDb250cm9sbGVyTW9kZWw7XG5sZXQgaXNJbW1lcnNpdmUgPSBmYWxzZTtcblxuLyoqXG4gKiBBZGRzIHRoZSBldmVudCBoYW5kbGVycyBmb3IgVlIgbW90aW9uIGNvbnRyb2xsZXJzIHRvIGxvYWQgdGhlIGFzc2V0cyBvbiBjb25uZWN0aW9uXG4gKiBhbmQgcmVtb3ZlIHRoZW0gb24gZGlzY29ubmVjdGlvblxuICogQHBhcmFtIHtudW1iZXJ9IGluZGV4XG4gKi9cbmZ1bmN0aW9uIGluaXRpYWxpemVWUkNvbnRyb2xsZXIoaW5kZXgpIHtcbiAgY29uc3QgdnJDb250cm9sbGVyID0gdGhyZWUucmVuZGVyZXIueHIuZ2V0Q29udHJvbGxlcihpbmRleCk7XG5cbiAgdnJDb250cm9sbGVyLmFkZEV2ZW50TGlzdGVuZXIoJ2Nvbm5lY3RlZCcsIGFzeW5jIChldmVudCkgPT4ge1xuICAgIGNvbnN0IGNvbnRyb2xsZXJNb2RlbCA9IG5ldyBDb250cm9sbGVyTW9kZWwoKTtcbiAgICB2ckNvbnRyb2xsZXIuYWRkKGNvbnRyb2xsZXJNb2RlbCk7XG5cbiAgICBjb25zdCBtb3Rpb25Db250cm9sbGVyID0gYXdhaXQgcHJvZmlsZVNlbGVjdG9yLmNyZWF0ZU1vdGlvbkNvbnRyb2xsZXIoZXZlbnQuZGF0YSk7XG4gICAgYXdhaXQgY29udHJvbGxlck1vZGVsLmluaXRpYWxpemUobW90aW9uQ29udHJvbGxlcik7XG4gIH0pO1xuXG4gIHZyQ29udHJvbGxlci5hZGRFdmVudExpc3RlbmVyKCdkaXNjb25uZWN0ZWQnLCAoKSA9PiB7XG4gICAgdnJDb250cm9sbGVyLnJlbW92ZSh2ckNvbnRyb2xsZXIuY2hpbGRyZW5bMF0pO1xuICB9KTtcblxuICB0aHJlZS5zY2VuZS5hZGQodnJDb250cm9sbGVyKTtcbn1cblxuLyoqXG4gKiBUaGUgdGhyZWUuanMgcmVuZGVyIGxvb3AgKHVzZWQgaW5zdGVhZCBvZiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUgdG8gc3VwcG9ydCBYUilcbiAqL1xuZnVuY3Rpb24gcmVuZGVyKCkge1xuICBpZiAobW9ja0NvbnRyb2xsZXJNb2RlbCkge1xuICAgIGlmIChpc0ltbWVyc2l2ZSkge1xuICAgICAgdGhyZWUuc2NlbmUucmVtb3ZlKG1vY2tDb250cm9sbGVyTW9kZWwpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJlZS5zY2VuZS5hZGQobW9ja0NvbnRyb2xsZXJNb2RlbCk7XG4gICAgICBNYW51YWxDb250cm9scy51cGRhdGVUZXh0KCk7XG4gICAgfVxuICB9XG5cbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMudXBkYXRlKCk7XG5cbiAgdGhyZWUucmVuZGVyZXIucmVuZGVyKHRocmVlLnNjZW5lLCB0aHJlZS5jYW1lcmEpO1xufVxuXG4vKipcbiAqIEBkZXNjcmlwdGlvbiBFdmVudCBoYW5kbGVyIGZvciB3aW5kb3cgcmVzaXppbmcuXG4gKi9cbmZ1bmN0aW9uIG9uUmVzaXplKCkge1xuICBjb25zdCB3aWR0aCA9IGNhbnZhc1BhcmVudEVsZW1lbnQuY2xpZW50V2lkdGg7XG4gIGNvbnN0IGhlaWdodCA9IGNhbnZhc1BhcmVudEVsZW1lbnQuY2xpZW50SGVpZ2h0O1xuICB0aHJlZS5jYW1lcmEuYXNwZWN0UmF0aW8gPSB3aWR0aCAvIGhlaWdodDtcbiAgdGhyZWUuY2FtZXJhLnVwZGF0ZVByb2plY3Rpb25NYXRyaXgoKTtcbiAgdGhyZWUucmVuZGVyZXIuc2V0U2l6ZSh3aWR0aCwgaGVpZ2h0KTtcbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMudXBkYXRlKCk7XG59XG5cbi8qKlxuICogSW5pdGlhbGl6ZXMgdGhlIHRocmVlLmpzIHJlc291cmNlcyBuZWVkZWQgZm9yIHRoaXMgcGFnZVxuICovXG5mdW5jdGlvbiBpbml0aWFsaXplVGhyZWUoKSB7XG4gIGNhbnZhc1BhcmVudEVsZW1lbnQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbW9kZWxWaWV3ZXInKTtcbiAgY29uc3Qgd2lkdGggPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudFdpZHRoO1xuICBjb25zdCBoZWlnaHQgPSBjYW52YXNQYXJlbnRFbGVtZW50LmNsaWVudEhlaWdodDtcblxuICAvLyBTZXQgdXAgdGhlIFRIUkVFLmpzIGluZnJhc3RydWN0dXJlXG4gIHRocmVlLmNhbWVyYSA9IG5ldyBUSFJFRS5QZXJzcGVjdGl2ZUNhbWVyYSg3NSwgd2lkdGggLyBoZWlnaHQsIDAuMDEsIDEwMDApO1xuICB0aHJlZS5jYW1lcmEucG9zaXRpb24ueSA9IDAuNTtcbiAgdGhyZWUuc2NlbmUgPSBuZXcgVEhSRUUuU2NlbmUoKTtcbiAgdGhyZWUuc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBUSFJFRS5Db2xvcigweDAwYWE0NCk7XG4gIHRocmVlLnJlbmRlcmVyID0gbmV3IFRIUkVFLldlYkdMUmVuZGVyZXIoeyBhbnRpYWxpYXM6IHRydWUgfSk7XG4gIHRocmVlLnJlbmRlcmVyLnNldFNpemUod2lkdGgsIGhlaWdodCk7XG4gIHRocmVlLnJlbmRlcmVyLmdhbW1hT3V0cHV0ID0gdHJ1ZTtcblxuICAvLyBTZXQgdXAgdGhlIGNvbnRyb2xzIGZvciBtb3ZpbmcgdGhlIHNjZW5lIGFyb3VuZFxuICB0aHJlZS5jYW1lcmFDb250cm9scyA9IG5ldyBPcmJpdENvbnRyb2xzKHRocmVlLmNhbWVyYSwgdGhyZWUucmVuZGVyZXIuZG9tRWxlbWVudCk7XG4gIHRocmVlLmNhbWVyYUNvbnRyb2xzLmVuYWJsZURhbXBpbmcgPSB0cnVlO1xuICB0aHJlZS5jYW1lcmFDb250cm9scy5taW5EaXN0YW5jZSA9IDAuMDU7XG4gIHRocmVlLmNhbWVyYUNvbnRyb2xzLm1heERpc3RhbmNlID0gMC4zO1xuICB0aHJlZS5jYW1lcmFDb250cm9scy5lbmFibGVQYW4gPSBmYWxzZTtcbiAgdGhyZWUuY2FtZXJhQ29udHJvbHMudXBkYXRlKCk7XG5cbiAgLy8gU2V0IHVwIHRoZSBsaWdodHMgc28gdGhlIG1vZGVsIGNhbiBiZSBzZWVuXG4gIGNvbnN0IGJvdHRvbURpcmVjdGlvbmFsTGlnaHQgPSBuZXcgVEhSRUUuRGlyZWN0aW9uYWxMaWdodCgweEZGRkZGRiwgMik7XG4gIGJvdHRvbURpcmVjdGlvbmFsTGlnaHQucG9zaXRpb24uc2V0KDAsIC0xLCAwKTtcbiAgdGhyZWUuc2NlbmUuYWRkKGJvdHRvbURpcmVjdGlvbmFsTGlnaHQpO1xuICBjb25zdCB0b3BEaXJlY3Rpb25hbExpZ2h0ID0gbmV3IFRIUkVFLkRpcmVjdGlvbmFsTGlnaHQoMHhGRkZGRkYsIDIpO1xuICB0aHJlZS5zY2VuZS5hZGQodG9wRGlyZWN0aW9uYWxMaWdodCk7XG5cbiAgLy8gQWRkIFZSXG4gIGNhbnZhc1BhcmVudEVsZW1lbnQuYXBwZW5kQ2hpbGQoVlJCdXR0b24uY3JlYXRlQnV0dG9uKHRocmVlLnJlbmRlcmVyKSk7XG4gIHRocmVlLnJlbmRlcmVyLnhyLmVuYWJsZWQgPSB0cnVlO1xuICB0aHJlZS5yZW5kZXJlci54ci5hZGRFdmVudExpc3RlbmVyKCdzZXNzaW9uc3RhcnQnLCAoKSA9PiB7IGlzSW1tZXJzaXZlID0gdHJ1ZTsgfSk7XG4gIHRocmVlLnJlbmRlcmVyLnhyLmFkZEV2ZW50TGlzdGVuZXIoJ3Nlc3Npb25lbmQnLCAoKSA9PiB7IGlzSW1tZXJzaXZlID0gZmFsc2U7IH0pO1xuICBpbml0aWFsaXplVlJDb250cm9sbGVyKDApO1xuICBpbml0aWFsaXplVlJDb250cm9sbGVyKDEpO1xuXG4gIC8vIEFkZCB0aGUgVEhSRUUuanMgY2FudmFzIHRvIHRoZSBwYWdlXG4gIGNhbnZhc1BhcmVudEVsZW1lbnQuYXBwZW5kQ2hpbGQodGhyZWUucmVuZGVyZXIuZG9tRWxlbWVudCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLCBvblJlc2l6ZSwgZmFsc2UpO1xuXG4gIC8vIFN0YXJ0IHB1bXBpbmcgZnJhbWVzXG4gIHRocmVlLnJlbmRlcmVyLnNldEFuaW1hdGlvbkxvb3AocmVuZGVyKTtcbn1cblxuZnVuY3Rpb24gb25TZWxlY3Rpb25DbGVhcigpIHtcbiAgTWFudWFsQ29udHJvbHMuY2xlYXIoKTtcbiAgaWYgKG1vY2tDb250cm9sbGVyTW9kZWwpIHtcbiAgICB0aHJlZS5zY2VuZS5yZW1vdmUobW9ja0NvbnRyb2xsZXJNb2RlbCk7XG4gICAgbW9ja0NvbnRyb2xsZXJNb2RlbCA9IG51bGw7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gb25TZWxlY3Rpb25DaGFuZ2UoKSB7XG4gIG9uU2VsZWN0aW9uQ2xlYXIoKTtcbiAgY29uc3QgbW9ja0dhbWVwYWQgPSBuZXcgTW9ja0dhbWVwYWQocHJvZmlsZVNlbGVjdG9yLnByb2ZpbGUsIHByb2ZpbGVTZWxlY3Rvci5oYW5kZWRuZXNzKTtcbiAgY29uc3QgbW9ja1hSSW5wdXRTb3VyY2UgPSBuZXcgTW9ja1hSSW5wdXRTb3VyY2UobW9ja0dhbWVwYWQsIHByb2ZpbGVTZWxlY3Rvci5oYW5kZWRuZXNzKTtcbiAgbW9ja0NvbnRyb2xsZXJNb2RlbCA9IG5ldyBDb250cm9sbGVyTW9kZWwobW9ja1hSSW5wdXRTb3VyY2UpO1xuICB0aHJlZS5zY2VuZS5hZGQobW9ja0NvbnRyb2xsZXJNb2RlbCk7XG5cbiAgY29uc3QgbW90aW9uQ29udHJvbGxlciA9IGF3YWl0IHByb2ZpbGVTZWxlY3Rvci5jcmVhdGVNb3Rpb25Db250cm9sbGVyKG1vY2tYUklucHV0U291cmNlKTtcbiAgTWFudWFsQ29udHJvbHMuYnVpbGQobW90aW9uQ29udHJvbGxlcik7XG4gIGF3YWl0IG1vY2tDb250cm9sbGVyTW9kZWwuaW5pdGlhbGl6ZShtb3Rpb25Db250cm9sbGVyKTtcbn1cblxuLyoqXG4gKiBQYWdlIGxvYWQgaGFuZGxlciBmb3IgaW5pdGlhbHppbmcgdGhpbmdzIHRoYXQgZGVwZW5kIG9uIHRoZSBET00gdG8gYmUgcmVhZHlcbiAqL1xuZnVuY3Rpb24gb25Mb2FkKCkge1xuICBBc3NldEVycm9yLmluaXRpYWxpemUoKTtcbiAgcHJvZmlsZVNlbGVjdG9yID0gbmV3IFByb2ZpbGVTZWxlY3RvcigpO1xuICBpbml0aWFsaXplVGhyZWUoKTtcblxuICBwcm9maWxlU2VsZWN0b3IuYWRkRXZlbnRMaXN0ZW5lcignc2VsZWN0aW9uY2xlYXInLCBvblNlbGVjdGlvbkNsZWFyKTtcbiAgcHJvZmlsZVNlbGVjdG9yLmFkZEV2ZW50TGlzdGVuZXIoJ3NlbGVjdGlvbmNoYW5nZScsIG9uU2VsZWN0aW9uQ2hhbmdlKTtcbn1cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgb25Mb2FkKTtcbiJdLCJuYW1lcyI6WyJUSFJFRS5PYmplY3QzRCIsIkNvbnN0YW50cyIsIlRIUkVFLlF1YXRlcm5pb24iLCJUSFJFRS5TcGhlcmVHZW9tZXRyeSIsIlRIUkVFLk1lc2hCYXNpY01hdGVyaWFsIiwiVEhSRUUuTWVzaCIsIlRIUkVFLlBlcnNwZWN0aXZlQ2FtZXJhIiwiVEhSRUUuU2NlbmUiLCJUSFJFRS5Db2xvciIsIlRIUkVFLldlYkdMUmVuZGVyZXIiLCJUSFJFRS5EaXJlY3Rpb25hbExpZ2h0Il0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7O0FBQUEsSUFBSSxnQkFBZ0IsQ0FBQztBQUNyQixJQUFJLFdBQVcsQ0FBQztBQUNoQixJQUFJLG1CQUFtQixDQUFDOztBQUV4QixTQUFTLFVBQVUsR0FBRztFQUNwQixJQUFJLGdCQUFnQixFQUFFO0lBQ3BCLE1BQU0sQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsU0FBUyxLQUFLO01BQ2hFLE1BQU0sV0FBVyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztNQUNwRSxXQUFXLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7S0FDakUsQ0FBQyxDQUFDO0dBQ0o7Q0FDRjs7QUFFRCxTQUFTLG1CQUFtQixDQUFDLEtBQUssRUFBRTtFQUNsQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUM7RUFDdkMsV0FB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
