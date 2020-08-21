
const textElement = document.getElementById('text');
const formElement = document.getElementById('form');
const imgElement = document.getElementById('img');
const showElement = document.getElementById('show');
const toggleSwitch = document.querySelector('input[type="checkbox"]');
const icon = document.getElementById('icon');
const toggleText = document.querySelector('.toggle-text');
const Clarifai = require('clarifai');
const dark_mode = "dark";
const light_mode = "light";

//Dark & Light Switcher
function switcherDarkLight(variable) {
    variable === "dark"
        ? document.documentElement.setAttribute('data-theme', 'dark')
        : document.documentElement.setAttribute('data-theme', 'light');

    variable === "dark"
        ? icon.className = "fas fa-moon"
        : icon.className = "fas fa-sun";

    variable === "dark"
        ? icon.style.color = "white"
        : icon.style.color = "black";

    variable === "dark"
        ? toggleText.textContent = "Dark Mode"
        : toggleText.textContent = "Light Mode";
}
// Theme Switcher
function switchTheme(event) {
    if (event.target.checked) {
        switcherDarkLight(dark_mode);
        localStorage.setItem('theme', 'dark');
    } else {
        switcherDarkLight(light_mode)
        localStorage.setItem('theme', 'light');
    }
}
// Calculating the position elements for the image
const calculateFaceLocation = (data) => {
    const clarifaiFace = data.outputs[0].data.regions[0].region_info.bounding_box;
    const width = Number(imgElement.width);
    const height = Number(imgElement.height);
    const box = document.getElementById('bounding-box');
    const elementPosition = {
        leftCol: clarifaiFace.left_col * width,
        topRow: clarifaiFace.top_row * height,
        rightCol: width - (clarifaiFace.right_col * width),
        bottomRow: height - (clarifaiFace.bottom_row * height)
    }
    box.style.left = `${elementPosition.leftCol}px`;
    box.style.right = `${elementPosition.rightCol}px`;
    box.style.bottom = `${elementPosition.bottomRow}px`;
    box.style.top = `${elementPosition.topRow}px`;

}
// Sending the image to the API
const sendData = () => {
    const app = new Clarifai.App({
        apiKey: 'acd573ddf7df4d409a06eb22e1768f6b'
    });

    app.models.predict(Clarifai.FACE_DETECT_MODEL, textElement.value)
        .then(response => console.log(calculateFaceLocation(response)))
        .catch(e => alert(e))
}

const currentTheme = localStorage.getItem('theme');
if (currentTheme) {
    document.documentElement.setAttribute('data-theme', currentTheme);
    if (currentTheme === "dark") {
        toggleSwitch.checked = true;
        switcherDarkLight(dark_mode);
        localStorage.setItem('theme', 'dark');
    }
}

// Listener
formElement.addEventListener('submit', (e) => {
    e.preventDefault();
    imgElement.src = textElement.value;
    sendData();
});


toggleSwitch.addEventListener('change', switchTheme);

