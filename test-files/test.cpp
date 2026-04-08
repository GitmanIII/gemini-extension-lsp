#include <iostream>
#include <string>

class CppTest {
public:
    std::string hello() {
        return 123; // Error: no viable conversion
    }
};

int main() {
    CppTest test;
    test.wrong(); // Error: no member named 'wrong'
    return 0;
}